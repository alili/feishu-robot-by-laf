import cloud from '@/cloud-sdk'
import * as dayjs from 'dayjs'
import * as FSDK from 'feishu-sdk'
import * as axios from 'axios'
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.tz.setDefault('Asia/Shanghai')

// const GROUP_ID = 'e6288gb4'
const GROUP_ID = 'oc_95339d8e8c836d3ce29ee665b3cac594'
const db = cloud.database()
let LAPI

exports.main = async function (ctx: FunctionContext) {
  // body, query 为请求参数, auth 是授权对象
  const { auth, body, query } = ctx

  // 飞书事件监听绑定
  if (body.challenge) {
    return {
      challenge: body.challenge,
    }
  }
  // 初始化API
  const { cookies, csrf, key, secret } = (await db.collection('Meta').doc('leetcode').get()).data
  const FAPI = FSDK(key, secret)
  axios.defaults.headers['cookie'] = cookies
  axios.defaults.headers['x-csrftoken'] = csrf
  axios.defaults.headers['origin'] = 'https://leetcode.cn'

  // 获取缓存token或请求token
  let token = await db.collection('Meta').doc('leetcode_token').get()
  if (token.data?.indate > new Date().getTime()) {
    token = token?.data
  } else {
    token = await FAPI.getTenantToken()
    token.indate = new Date().getTime() + token.expire * 1000
    await db.collection('Meta').doc('leetcode_token').set(token)
  }
  FAPI.setToken(token.tenant_access_token)

  // 增加GET事件
  if (query) {
    // 手动发送每日一题
    if (query.today) {
      let res = await LAPI.getQuestionOfToday()
      const q = res.todayRecord[0].question

      const questionMessage = await FAPI.sendMessage(GROUP_ID, makeQuestionCard(q), 'interactive')

      const data = await FAPI.putMessageTop(questionMessage.chat_id, questionMessage.message_id)
      return data
    }
    // 发送排名
    if (query.rank) {
      let frontendQuestionId = query.rank
      if (frontendQuestionId === 'today') {
        let res = await LAPI.getQuestionOfToday()
        const q = res.todayRecord[0].question
        frontendQuestionId = q.frontendQuestionId
      }

      let results = await db
        .collection('LeetcodeUser')
        .where({
          frontendQuestionId,
        })
        .get()

      await FAPI.sendMessage(GROUP_ID, makeRankCard(results.data), 'interactive')
      return
    }
  }

  // 按钮事件
  if (body.action) {
    const { difficulty, limit, users, owner, chat_id } = body.action.value
    const user = (await FAPI.getUserInfo(body.user_id)).data.user
    const avatar = await FAPI.uploadImage({ url: user.avatar.avatar_72 })

    // 进入群内
    FAPI.setToken(token.tenant_access_token)
    await FAPI.addMembers(chat_id, [body.user_id])
    // 更新卡片
    return makeChallengeCard({
      owner,
      difficulty,
      limit,
      users: users.concat([
        {
          avatar,
          username: user.name,
          uid: user.user_id,
        },
      ]),
      chat_id,
    })
  }

  const {
    header,
    event: { message, sender },
  } = body

  // 避免冗余事件
  const _event = header.event_id && (await db.collection('Events').doc(header.event_id).get()).data
  if (_event) {
    return {}
  } else {
    db.collection('Events').doc(header.event_id).set(message)
  }

  const msg = JSON.parse(message.content).text

  switch (header.event_type) {
    case 'im.message.receive_v1':
      if (message.chat_type === 'p2p') {
        let res = await LAPI.getQuestionOfToday()
        const q = res.todayRecord[0].question

        // 无法识别的代码，报错
        if (!judgeLanguage(msg)) {
          await FAPI.sendTextMessage(sender.sender_id.user_id, '请输入合法代码')
          return {}
        }

        const submitId = await LAPI.submit({
          questionSlug: q.titleSlug,
          typed_code: msg,
          question_id: q.questionId,
          lang: judgeLanguage(msg),
        })
        await FAPI.sendTextMessage(sender.sender_id.user_id, '代码已收到，正在努力打分...')

        // 多次重试直到获取judge结果
        let checkResult = null
        while (!checkResult || checkResult.state !== 'SUCCESS') {
          checkResult = await LAPI.checkSubmission(submitId)
          await sleep(500)
        }

        let user = await FAPI.getUserInfo(sender.sender_id.user_id)
        // 发送结果到群内
        if (checkResult.status_msg === 'Accepted') {
          let results = await db
            .collection('LeetcodeUser')
            .where({
              frontendQuestionId: q.frontendQuestionId,
            })
            .get()

          let rank = results.data.reduce(
            (rank, item) => {
              if (item.runtime_percentile !== 100 && item.runtime_percentile >= checkResult.runtime_percentile)
                rank[0]++
              if (item.memory_percentile >= checkResult.memory_percentile) rank[1]++
              return rank
            },
            [0, 0]
          )

          // 发消息
          // 不接受早于6点的提交
          await FAPI.sendMessage(
            dayjs().tz().valueOf() < dayjs().tz().startOf('d').add(6, 'h').valueOf() ||
              dayjs().tz().valueOf() > dayjs().tz().startOf('d').add(23, 'h').valueOf()
              ? sender.sender_id.user_id
              : GROUP_ID,
            await makeACCard({
              ...checkResult,
              username: user.data.user.name,
              uid: sender.sender_id.user_id,
              rank,
            }),
            'interactive'
          )

          // 结果存入数据库
          await db.collection('LeetcodeUser').add({
            ...checkResult,
            uid: sender.sender_id.user_id,
            username: user.data.user.name,
            frontendQuestionId: q.frontendQuestionId,
            titleCn: q.titleCn,
          })
        } else {
          await FAPI.sendMessage(
            sender.sender_id.user_id,
            makeWrongAnswerCard({
              ...checkResult,
              username: user.data.user.name,
            }),
            'interactive'
          )
        }
      }

      // 2.0 副本模式
      if (message.chat_type === 'group') {
        const difficulty = msg.match(/(easy|medium|hard)/g)?.[0]
        const limit = msg.match(/\d+/g)?.[1]
        let user = (await FAPI.getUserInfo(sender.sender_id.user_id)).data.user

        FAPI.setToken(token.tenant_access_token)
        if (!difficulty || !limit) {
          await FAPI.sendTextMessage(sender.sender_id.user_id, '输入[easy|medium|hard]+人数')
          return
        }
        // 创建副本（群）

        let chats = await FAPI.createChats({
          user_id_list: [user.user_id],
          owner_id: user.user_id,
          name: `${user.name} 发起的挑战`,
        })

        // 落库
        // 开始报名
        await FAPI.sendMessage(
          message.chat_id,
          makeChallengeCard({
            owner: sender.sender_id.user_id,
            difficulty,
            limit,
            users: [],
            chat_id: chats.data.chat_id,
          }),
          'interactive'
        )
        return
      }
  }
  return { msg }
}

//工具函数
async function sleep(t) {
  return new Promise((resolve) => {
    setTimeout(() => {
      return resolve(true)
    }, t)
  })
}
async function judgeLanguage(code) {
  if (/func\s/.test(code)) return 'golang'
  if (/class \w+:/.test(code)) return 'python3'
  if (/def\s/.test(code)) return 'python'
  if (/public:/.test(code)) return 'cpp'
  if (/public class  \w+\{/.test(code)) return 'csharp'
  if (/class \w+[\s\S]*public/.test(code)) return 'java'
  if (/class \w+ \{/.test(code)) return 'php'
  if (/@param/.test(code)) return 'javascript'
  if (/impl \w+/.test(code)) return 'rust'
  if (/(char|boolean|int)/.test(code)) return 'c'

  return ''
}

// 配置项
const queryConfig = {
  questionOfToday: `
    query questionOfToday {
     todayRecord {
       date
       userStatus
       question {
         questionId
         frontendQuestionId: questionFrontendId
         difficulty
         title
         titleCn: translatedTitle
         translatedContent
         titleSlug
         paidOnly: isPaidOnly
         acRate
         likes
         status
         stats
         solutionNum
         topicTags {
           name
           nameTranslated: translatedName
           id
         }
       }
       lastSubmission {
         id
       }
     }
   }
   `,
}
const submitImage = {
  3: 'img_v2_41d61107-6993-4d03-854a-6e0d4a71ca5g',
  5: 'img_v2_90a6ec7e-c042-4c70-a9c6-f404ba55624g',
  10: 'img_v2_fbeec5df-121c-4563-9bc8-737e8af4a5dg',
  15: 'img_v2_90e38e7b-795a-4469-90fb-3f0f85ebf2cg',
  20: 'img_v2_86af13e2-4937-4a80-a2e3-3cb483f48c0g',
  30: 'img_v2_9060f882-8934-4873-b1b7-edf9844a597g',
  60: 'img_v2_97c7ef9a-7be3-4009-ab3e-8a9171456b4g',
  100: 'img_v2_04fd08dd-8151-44dc-a7ce-f7150d00420g',
}
const emojiMap = {
  0: '🥇',
  1: '🥈',
  2: '🥉',
  3: '🏅',
  4: '🏅',
}

//消息卡片
async function makeQuestionCard({
  translatedContent,
  stats,
  acRate,
  topicTags,
  titleSlug,
  frontendQuestionId,
  titleCn,
  difficulty,
}) {
  return {
    config: {
      wide_screen_mode: true,
    },
    elements: [
      {
        tag: 'markdown',
        content: translatedContent.replace(/<.*?>/g, ''),
      },
      {
        tag: 'hr',
      },
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**提交：**${JSON.parse(stats).totalSubmission}`,
            },
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**通过率：**${(acRate * 100).toFixed(2)}%`,
            },
          },
        ],
      },
      {
        tag: 'markdown',
        content: `**标签：** ${topicTags.map((item) => item.nameTranslated).join('、')}`,
      },
      {
        tag: 'markdown',
        content: `[题目链接](https://leetcode.cn/problems/${titleSlug}/)`,
      },
    ],
    header: {
      template: difficulty === 'Hard' ? 'red' : difficulty === 'Easy' ? 'green' : 'orange',
      title: {
        content: `【${dayjs().tz().format('MM月DD日')}】${frontendQuestionId}.${titleCn}`,
        tag: 'plain_text',
      },
    },
  }
}
async function makeWrongAnswerCard({
  total_correct,
  total_testcases,
  pretty_lang,
  last_testcase,
  expected_output,
  code_output,
  username,
  status_msg,
}) {
  return {
    elements: [
      {
        tag: 'markdown',
        content: `**所用语言：** \n ${pretty_lang}`,
      },
      {
        tag: 'markdown',
        content: `**错误类型：** \n ${status_msg}`,
      },
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**总测试用例：**${total_testcases}`,
            },
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**通过用例：**${total_correct}`,
            },
          },
        ],
      },
      {
        tag: 'markdown',
        content: `**测试用例：** \n ${last_testcase}`,
      },
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**预期输出：**\n${expected_output}`,
            },
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**实际输出：**\n${code_output}`,
            },
          },
        ],
      },
    ],
    header: {
      template: 'red',
      title: {
        content: `❌ 答案错误 ${username} ❌`,
        tag: 'plain_text',
      },
    },
  }
}
async function makeACCard({
  pretty_lang,
  runtime_percentile,
  memory_percentile,
  status_memory,
  status_runtime,
  rank,
  submission_id,
  username,
  uid,
  task_finish_time,
}) {
  const times = [
    ...new Set(
      (
        await db
          .collection('LeetcodeUser')
          .where({
            uid,
          })
          .get()
      ).data.map(({ task_finish_time }) => Math.floor((task_finish_time + 1000 * 60 * 60 * 8) / (1000 * 60 * 60 * 24)))
    ),
  ]
  const isFirst = !times.length

  let today = Math.floor((task_finish_time + 1000 * 60 * 60 * 8) / (1000 * 60 * 60 * 24))
  let seriesDays = 1
  if (times.slice(-1)[0] === today) {
    times.pop()
  }
  while (times.pop() === --today) {
    seriesDays++
  }

  let elements = [
    {
      tag: 'markdown',
      content: `**使用语言：**${pretty_lang}`,
    },
    {
      tag: 'div',
      fields: [
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**使用内存：**${status_memory}`,
          },
        },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**使用时间：**${status_runtime}`,
          },
        },
      ],
    },
    {
      tag: 'div',
      fields: [
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**内存排名：**${memory_percentile.toFixed()}% ${rank[1] < 3 ? emojiMap[rank[1]] : ''}`,
          },
        },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**用时排名：**${runtime_percentile.toFixed()}% ${rank[0] < 3 ? emojiMap[rank[0]] : ''}`,
          },
        },
      ],
    },
    {
      tag: 'markdown',
      content: `[解答详情](https://leetcode.cn/submissions/detail/${submission_id})`,
    },
  ]

  if (isFirst) {
    elements.unshift({
      tag: 'img',
      img_key: 'img_v2_b60e8bed-fb1f-4385-bdc0-e4840f1c59fg',
      alt: {
        tag: 'plain_text',
        content: '首次提交！',
      },
    })
  }

  if (Object.keys(submitImage).includes(seriesDays.toString())) {
    elements.unshift({
      tag: 'img',
      img_key: submitImage[seriesDays],
      alt: {
        tag: 'plain_text',
        content: `连续${seriesDays}天提交！`,
      },
    })
  }

  return {
    elements,
    header: {
      template: 'green',
      title: {
        content: isFirst ? `🎉 恭喜 ${username} 首次提交成功🎉` : `${username} 已连续${seriesDays}天提交成功`,
        tag: 'plain_text',
      },
    },
  }
}
async function makeRankCard(results) {
  let users = [...new Set(results.map((item) => item.uid))]
  let temp = {}
  let timeRank = results
    .sort((a, b) => b.runtime_percentile - a.runtime_percentile || a.task_finish_time - b.task_finish_time)
    .filter((item) => {
      if (item.runtime_percentile === 100) return false
      if (!temp[item.uid + item.pretty_lang]) {
        temp[item.uid + item.pretty_lang] = 0
      }
      return !temp[item.uid + item.pretty_lang]++
    })
    .slice(0, 5)
  temp = {}
  let memoryRank = results
    .sort((a, b) => b.memory_percentile - a.memory_percentile || a.task_finish_time - b.task_finish_time)
    .filter((item) => {
      if (item.memory_percentile === 100) return false
      if (!temp[item.uid + item.pretty_lang]) {
        temp[item.uid + item.pretty_lang] = 0
      }
      return !temp[item.uid + item.pretty_lang]++
    })
    .slice(0, 5)
  const langs = results.reduce((obj, result) => {
    if (!obj[result.pretty_lang]) {
      obj[result.pretty_lang] = 0
    }
    obj[result.pretty_lang]++
    return obj
  }, {})
  const superUsersForTime = results.reduce((obj, result) => {
    if (result.runtime_percentile === 100) {
      if (!obj[result.uid]) {
        obj[result.uid] = []
      }
      if (!obj[result.uid].includes(result.pretty_lang)) {
        obj[result.uid].push(result.pretty_lang)
      }
    }
    return obj
  }, {})
  const superUsersForMemory = results.reduce((obj, result) => {
    if (result.memory_percentile === 100) {
      if (!obj[result.uid]) {
        obj[result.uid] = []
      }
      if (!obj[result.uid].includes(result.pretty_lang)) {
        obj[result.uid].push(result.pretty_lang)
      }
    }
    return obj
  }, {})

  let header = {
    template: 'blue',
    title: {
      content: `🏆 【${dayjs().add(8, 'h').format('MM月DD日')}】 ${results[0].frontendQuestionId}.${
        results[0].titleCn
      } 排行榜`,
      tag: 'plain_text',
    },
  }

  return {
    header,
    elements: [
      {
        tag: 'markdown',
        content: '**用时榜**',
      },
      {
        tag: 'markdown',
        content: `**满分选手：** ${Object.entries(superUsersForTime)
          .map(([uid, langs]) => `<at id=${uid}></at>(${langs.join(', ')})`)
          .join(' ')}`,
      },
      ...timeRank.map((item, index) => ({
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**${emojiMap[index]} &nbsp; **[${item.username}(${item.pretty_lang})](https://leetcode.cn/submissions/detail/${item.submission_id})`,
            },
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**用时排名 / 时间：** ${item.runtime_percentile.toFixed(2)}% / ${item.status_runtime}`,
            },
          },
        ],
      })),
      {
        tag: 'hr',
      },
      {
        tag: 'markdown',
        content: '**内存榜**',
      },
      {
        tag: 'markdown',
        content: `**满分选手：** ${Object.entries(superUsersForMemory)
          .map(([uid, langs]) => `<at id=${uid}></at>(${langs.join(', ')})`)
          .join(' ')}`,
      },
      ...memoryRank.map((item, index) => ({
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**${emojiMap[index]} &nbsp; **[${item.username}(${item.pretty_lang})](https://leetcode.cn/submissions/detail/${item.submission_id})`,
            },
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**内存排名 / 内存：** ${item.memory_percentile.toFixed(2)}% / ${item.status_memory}`,
            },
          },
        ],
      })),
      {
        tag: 'hr',
      },
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**今日使用语言：**\n${Object.entries(langs)
                .sort((a, b) => b[1] - a[1])
                .map(([key, value]) => `*${key}* x${value}`)
                .join(', ')}\n\n**今日共有${users.length}名同学提交：**\n${users.map((uid) => `<at id=${uid}></at>`)}`,
            },
          },
        ],
      },
    ],
  }
}
async function makeChallengeCard({ owner, difficulty, limit, users, chat_id }) {
  return {
    config: {
      update_multi: true, //声明这张卡片更新后，对所有的接收人都生效
    },
    elements: [
      {
        tag: 'div',
        text: {
          content: `<at user_id="${owner}""></at> 向群友发起挑战\n挑战难度为 【${difficulty}】`,
          tag: 'lark_md',
        },
      },
      {
        tag: 'markdown',
        content: `报名人数 *${users.length}/${limit}*`,
      },
      {
        tag: 'note',
        elements: users.map((user) => ({
          tag: 'img',
          img_key: user.avatar,
          alt: {
            tag: 'plain_text',
            content: user.username,
          },
        })),
      },
      {
        tag: 'markdown',
        content: '**战吗？**',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            value: {
              difficulty,
              owner,
              limit,
              users,
              chat_id,
            },
            text: {
              tag: 'plain_text',
              content: '战啊！',
            },
            type: 'primary',
          },
        ],
      },
    ],
    header: {
      template: 'red',
      title: {
        content: '一封挑战书',
        tag: 'plain_text',
      },
    },
  }
}

//Leetcode API
LAPI = {
  getQuestionOfToday: async () => {
    let res = await axios.post('https://leetcode.cn/graphql/', {
      query: queryConfig.questionOfToday,
    })
    return res.data.data
  },
  submit: async ({ questionSlug, lang, question_id, typed_code }) => {
    const url = `https://leetcode.cn/problems/${questionSlug}/submit/`
    const res = await axios.post(url, {
      lang,
      question_id,
      typed_code,
    })
    return res.data.submission_id
  },
  checkSubmission: async (submission_id) => {
    const url = `https://leetcode.cn/submissions/detail/${submission_id}/check/`
    const res = await axios.get(url)
    return res.data
  },
}
