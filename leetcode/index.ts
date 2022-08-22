import cloud from '@/cloud-sdk'
import * as dayjs from 'dayjs'
import * as FSDK from 'feishu-sdk'
import * as axios from 'axios'
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.tz.setDefault('Asia/Shanghai')

const ME = 'e6288gb4'
// const GROUP_ID = 'e6288gb4'
const GROUP_ID = 'oc_95339d8e8c836d3ce29ee665b3cac594'
const db = cloud.database()
let LAPI, FAPI

exports.main = async function (ctx: FunctionContext) {
  // body, query 为请求参数, auth 是授权对象
  const { body, query } = ctx
  let valid = await init(body)
  if (valid) {
    return valid
  }
   // 增加GET事件
  if (query) {
    // 手动发送每日一题
    if (query.today) {
      let res = await LAPI.getQuestionOfToday()
      const question = res.todayRecord[0].question
      const questionMessage = await FAPI.message.sendCard(GROUP_ID, makeQuestionCard(question))
      const data = await FAPI.chats.putMessageTop(questionMessage.chat_id, questionMessage.message_id)
      return data
    }

    // 发送排名
    if (query.rank) {
      let frontendQuestionId = query.rank
      if (frontendQuestionId === 'today') {
        let res = await LAPI.getQuestionOfToday()
        const question = res.todayRecord[0].question
        frontendQuestionId = question.frontendQuestionId
      }

      let results = await db
        .collection('LeetcodeUser')
        .where({
          frontendQuestionId,
        })
        .get()

      await FAPI.message.sendCard(GROUP_ID, makeRankCard(results.data))
      return
    }

    // 发送提醒
    if (query.notice) {
      const records = (await db.collection('LeetcodeNotice').limit(1000).get()).data
      
      records.forEach(({_id, seriesDays, noticeTime}) => {
        if (seriesDays >=3 && dayjs().isAfter(dayjs(noticeTime))) {
          FAPI.message.sendCard(_id, makeNoticeCard(seriesDays))
        }
      })

      return records

    }
  }

  // 按钮事件
  if (body.action) {
    const { type, action, seriesDays, difficulty, limit, users, owner, chat_id } = body.action.value
    switch (type) {
      case 'subscribe':
        switch (action) {
          case 'ok':
            await db.collection('LeetcodeNotice').doc(body.user_id).set({
              noticeTime: dayjs().add(1, 'day').startOf('day').valueOf(),
              seriesDays,
            })
            break;
          default:
            break;
        }
        return makeNoticeCard(0)
      default:
        const user = (await FAPI.getUserInfo(body.user_id)).data.user
        const avatar = await FAPI.uploadImage({ url: user.avatar.avatar_72 })
    
        // 进入群内
        await FAPI.chats.addMembers(chat_id, [body.user_id])
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
  }

  const {
    header,
    event,
    event: { message, sender },
  } = body
  
  const msg = message ? JSON.parse(message.content).text : ''

  FAPI.event.add('im.chat.member.user.added_v1', async () => {
    let uids = event.users.map(user => user.user_id.user_id)
    for(let i in uids) {
      await FAPI.message.sendText(uids[i], '直接复制力扣题解发送给我，即可参与每日一题活动')
    }

  })
  FAPI.event.add('im.message.receive_v1', async () => {
    if (message.chat_type === 'p2p') {
      if (msg === 'debug2') {
        const question = await LAPI.getRandomQuestion()
        const questionDetail = await LAPI.getQuestionDetail(question.titleSlug)
        const questionMessage = await FAPI.message.send(
          sender.sender_id.user_id,
          makeQuestionCard(questionDetail),
          'interactive'
        )
        return {}
      }
  
      let res = await LAPI.getQuestionOfToday()
      const question = res.todayRecord[0].question

      // 无法识别的代码，报错
      if (!judgeLanguage(msg)) {
        await FAPI.message.sendText(sender.sender_id.user_id, '请输入合法代码')
        return {}
      }
      const submitId = await LAPI.submit({
        questionSlug: question.titleSlug,
        typed_code: msg,
        question_id: question.questionId,
        lang: judgeLanguage(msg),
      })
      await FAPI.message.sendText(sender.sender_id.user_id, '代码已收到，正在努力打分...')
  
      // 多次重试直到获取judge结果
      let checkResult = null
      while (!checkResult || checkResult.state !== 'SUCCESS') {
        checkResult = await LAPI.checkSubmission(submitId)
        await sleep(500)
      }
  
      let user = await FAPI.user.getInfo(sender.sender_id.user_id)
      // 发送结果到群内
      if (checkResult.status_msg === 'Accepted') {
        let results = await db
          .collection('LeetcodeUser')
          .where({
            frontendQuestionId: question.frontendQuestionId,
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
  
        const records = (
          await db
            .collection('LeetcodeUser')
            .where({
              uid:sender.sender_id.user_id,
            })
            .get()
        ).data
      
        let {isFirst, seriesDays} = getDays(records)
        
        // 结果存入数据库
        await db.collection('LeetcodeUser').add({
          ...checkResult,
          uid: sender.sender_id.user_id,
          username: user.data.user.name,
          frontendQuestionId: question.frontendQuestionId,
          titleCn: question.titleCn,
        })
        

        await db.collection('LeetcodeNotice').doc(sender.sender_id.user_id).set({
          seriesDays,
          noticeTime: dayjs().add(1, 'day').startOf('day').valueOf(),
        })
        

        // 发消息
        await FAPI.message.sendCard(
          dayjs().tz().valueOf() < dayjs().tz().startOf('d').add(6, 'h').valueOf() ||
            dayjs().tz().valueOf() > dayjs().tz().startOf('d').add(23, 'h').valueOf()
            ? sender.sender_id.user_id
            : GROUP_ID,
          await makeACCard({
            ...checkResult,
            username: user.data.user.name,
            rank,
            seriesDays,
            isFirst
          })
        )
      } else {
        // 错误卡片发给个人
        await FAPI.message.sendCard(
          sender.sender_id.user_id,
          makeWrongAnswerCard({
            ...checkResult,
            username: user.data.user.name,
          })
        )
      }
    }
  
    // 2.0 副本模式
    if (message.chat_type === 'group') {
      const difficulty = msg.match(/(easy|medium|hard)/g)?.[0]
      const limit = msg.match(/\d+/g)?.[1]
      const user = (await FAPI.user.getInfo(sender.sender_id.user_id)).data.user
      const avatar = await FAPI.image.upload({ url: user.avatar.avatar_72 })
  
      FAPI.setToken(token.tenant_access_token)
      if (!difficulty || !limit) {
        await FAPI.message.sendText(sender.sender_id.user_id, '输入[easy|medium|hard]+人数')
        return
      }
      // 创建副本（群）
  
      const chats = await FAPI.chats.create({
        user_id_list: [user.user_id],
        owner_id: user.user_id,
        name: `${user.name} 发起的挑战`,
      })
  
      // 落库
      await db.collection('Challenges').add({
        owner: user.user_id,
        difficulty,
        limit,
        users: [
          {
            avatar,
            username: user.name,
            uid: user.user_id,
          },
        ],
        chat_id: chats.data.chat_id,
      })
  
      // 开始报名
      await FAPI.sendCard(
        message.chat_id,
        makeChallengeCard({
          owner: sender.sender_id.user_id,
          difficulty,
          limit,
          users: [
            {
              avatar,
              username: user.name,
            },
          ],
          chat_id: chats.data.chat_id,
        })
      )
      return
    }
  })
  
  await FAPI.event.listen(body)
  return { msg }
}

// init
async function init(body) {
  // 飞书事件监听绑定
  if (body.challenge) {
    return {
      challenge: body.challenge,
    }
  }
  // 初始化API
  const { cookies, csrf, key, secret } = (await db.collection('Meta').doc('leetcode').get()).data
  FAPI = await FSDK(key, secret, { noCache: true })
  
  axios.defaults.headers['cookie'] = cookies
  axios.defaults.headers['x-csrftoken'] = csrf
  axios.defaults.headers['origin'] = 'https://leetcode.cn'
  
  // 获取缓存token或请求token
  let token = await db.collection('Meta').doc(`${key}_token`).get()
  if (token.data?.indate > new Date().getTime()) {
    token = token?.data
  } else {
    token = await FAPI.getTenantToken()
    token.indate = new Date().getTime() + token.expire * 1000
    await db.collection('Meta').doc(`${key}_token`).set(token)
  }

  FAPI.setToken(token)

  // 避免冗余事件
  if (body?.header?.event_id ) {
    const _event = (await db.collection('Events').doc(body.header.event_id).get()).data
    if (_event) {
      return 'has event'
    } else {
      db.collection('Events').doc(body.header.event_id).set(body.event.message)
    }
  }

}

//工具函数
async function sleep(t) {
  return new Promise((resolve) => {
    setTimeout(() => {
      return resolve(true)
    }, t)
  })
}
function judgeLanguage(code) {
  if (/func\s/.test(code)) return 'golang'
  if (/class \w+:/.test(code)) return 'python3'
  if (/def\s/.test(code)) return 'python'
  if (/public:/.test(code)) return 'cpp'
  if (/public class \w+\{/.test(code)) return 'csharp'
  if (/class \w+[\s\S]*public/.test(code)) return 'java'
  if (/class \w+ \{/.test(code)) return 'php'
  if (/@param/.test(code)) return 'javascript'
  if (/impl \w+/.test(code)) return 'rust'
  if (/(char|boolean|int)/.test(code)) return 'c'

  return ''
}
function getDays(records) {
  records = [
    ...new Set(
      records.map(({ task_finish_time }) => Math.floor((task_finish_time + 1000 * 60 * 60 * 8) / (1000 * 60 * 60 * 24)))
    ),
  ]
  const isFirst = !records.length

  let today = Math.floor((new Date().getTime() + 1000 * 60 * 60 * 8) / (1000 * 60 * 60 * 24))
  let seriesDays = 0
  if (records.slice(-1)[0] === today) {
    records.pop()
  }
  while (records.pop() === --today) {
    seriesDays++
  }

  return {isFirst, seriesDays}
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
  randomQuestion: `
  query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
    problemsetQuestionList(
      categorySlug: $categorySlug
      limit: $limit
      skip: $skip
      filters: $filters
    ) {
      hasMore
      total
      questions {
        acRate
        difficulty
        freqBar
        frontendQuestionId
        isFavor
        paidOnly
        solutionNum
        status
        title
        titleCn
        titleSlug
        topicTags {
          name
          nameTranslated
          id
          slug
        }
        extra {
          hasVideoSolution
          topCompanyTags {
            imgUrl
            slug
            numSubscribed
          }
        }
      }
    }
  }
  `,
  questionDetail: `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      questionFrontendId
      categoryTitle
      boundTopicId
      title
      titleSlug
      content
      translatedTitle
      translatedContent
      isPaidOnly
      difficulty
      likes
      dislikes
      isLiked
      similarQuestions
      contributors {
        username
        profileUrl
        avatarUrl
        __typename
      }
      langToValidPlayground
      topicTags {
        name
        slug
        translatedName
        __typename
      }
      companyTagStats
      codeSnippets {
        lang
        langSlug
        code
        __typename
      }
      stats
      hints
      solution {
        id
        canSeeDetail
        __typename
      }
      status
      sampleTestCase
      metaData
      judgerAvailable
      judgeType
      mysqlSchemas
      enableRunCode
      envInfo
      book {
        id
        bookName
        pressName
        source
        shortDescription
        fullDescription
        bookImgUrl
        pressImgUrl
        productUrl
        __typename
      }
      isSubscribed
      isDailyQuestion
      dailyRecordStatus
      editorType
      ugcQuestionId
      style
      exampleTestcases
      jsonExampleTestcases
      __typename
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
function makeQuestionCard({
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
    header: FAPI.tools.makeHeader(difficulty === 'Hard' ? 'red' : difficulty === 'Easy' ? 'green' : 'orange',`【${dayjs().tz().format('MM月DD日')}】${frontendQuestionId}.${titleCn}`),
    elements: FAPI.tools.makeElements([
      translatedContent.replace(/<.*?>/g, ''),
      '---',
      [
        'text',
        `**提交：**${!stats ? JSON.parse(stats).totalSubmission : '-'}`,
        `**通过率：**${(acRate * 100).toFixed(2)}%`,
      ],
      `**标签：** ${topicTags.map((item) => item.nameTranslated).join('、')}`,
      `[题目链接](https://leetcode.cn/problems/${titleSlug}/)`,
    ]),
  }
}
function makeWrongAnswerCard({
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
    header: FAPI.tools.makeHeader('red', `❌ 答案错误 ${username} ❌`),
    elements: FAPI.tools.makeElements([
      `**所用语言：** \n ${pretty_lang}`,
      `**错误类型：** \n ${status_msg}`,
      ['text', `**总测试用例：**${total_testcases}`, `**通过用例：**${total_correct}`],
      `**测试用例：** \n ${last_testcase}`,
      ['text', `**预期输出：**\n${expected_output}`, `**实际输出：**\n${code_output}`],
    ]),
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
  isFirst,
  seriesDays
}) {
  let elements = [
    `**使用语言：**${pretty_lang}`,
    ['text', `**使用内存：**${status_memory}`, `**使用时间：**${status_runtime}`],
    [
      'text',
      `**内存排名：**${memory_percentile.toFixed()}% ${rank[1] < 3 ? emojiMap[rank[1]] : ''}`,
      `**用时排名：**${runtime_percentile.toFixed()}% ${rank[0] < 3 ? emojiMap[rank[0]] : ''}`,
    ],
    `[解答详情](https://leetcode.cn/submissions/detail/${submission_id})`,
  ]
  if (isFirst) {
    elements.unshift(`![首次提交！](img_v2_b60e8bed-fb1f-4385-bdc0-e4840f1c59fg)`)
  }

  if (Object.keys(submitImage).includes((seriesDays + 1).toString())) {
    elements.unshift(`![连续${seriesDays + 1}天提交！](${submitImage[seriesDays + 1]})`)
  }
  
  return {
    header: FAPI.tools.makeHeader('green', isFirst ? `🎉 恭喜 ${username} 首次提交成功🎉` : `${username} 已连续${seriesDays + 1}天提交成功`),
    elements: FAPI.tools.makeElements(elements),
  }
}
function makeRankCard(results) {
  const getRanks = (type) => {
    let res = {}
    return results
    .sort((a, b) => b[type] - a[type] || a.task_finish_time - b.task_finish_time)
      .filter((item) => {
        if (item[type] === 100) return false
        if (!res[item.uid + item.pretty_lang]) {
          res[item.uid + item.pretty_lang] = 0
        }
        return !res[item.uid + item.pretty_lang]++
      })
      .slice(0, 5)
  }

  const getSuperUser =  (type) => results.reduce((obj, result) => {
    if (result[type] === 100) {
      if (!obj[result.uid]) {
        obj[result.uid] = []
      }
      if (!obj[result.uid].includes(result.pretty_lang)) {
        obj[result.uid].push(result.pretty_lang)
      }
    }
    return obj
  }, {})
  
  const users = [...new Set(results.map((item) => item.uid))]
  const langs = results.reduce((obj, result) => {
    if (!obj[result.pretty_lang]) {
      obj[result.pretty_lang] = 0
    }
    obj[result.pretty_lang]++
    return obj
  }, {})
  
  const timeRank = getRanks('runtime_percentile')
  const memoryRank = getRanks('memory_percentile')
  const superUsersForTime = getSuperUser('runtime_percentile')
  const superUsersForMemory = getSuperUser('memory_percentile')

  const header = FAPI.tools.makeHeader('blue', `🏆 【${dayjs().add(8, 'h').format('MM月DD日')}】 ${results[0].frontendQuestionId}.${ results[0].titleCn } 排行榜`)
  const elements = FAPI.tools.makeElements([
    '**用时榜**',
    `**满分选手：** ${Object.entries(superUsersForTime)
        .map(([uid, langs]) => `@${uid}(${langs.join(', ')})`)
        .join(' ')}`,
    ...timeRank.map((item, index) => (['text', `**${emojiMap[index]} &nbsp; **[${item.username}(${item.pretty_lang})](https://leetcode.cn/submissions/detail/${item.submission_id})`,`**用时排名 / 时间：** ${item.runtime_percentile.toFixed(2)}% / ${item.status_runtime}`])),
    '---',
    '**内存榜**',
    `**满分选手：** ${Object.entries(superUsersForMemory)
        .map(([uid, langs]) => `@${uid}(${langs.join(', ')})`)
        .join(' ')}`,
    ...memoryRank.map((item, index) => (['text', `**${emojiMap[index]} &nbsp; **[${item.username}(${item.pretty_lang})](https://leetcode.cn/submissions/detail/${item.submission_id})`, `**内存排名 / 内存：** ${item.memory_percentile.toFixed(2)}% / ${item.status_memory}`])),
    '---',
    `**今日使用语言：**\n${Object.entries(langs)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `*${key}* x${value}`)
      .join(', ')}\n\n**今日共有${users.length}名同学提交：**\n${users.map((uid) => `@${uid}`)}`,
  ])

  return {
    header,
    elements,
  }
}
function makeChallengeCard({ owner, difficulty, limit, users, chat_id }) {
  return {
    config: {
      update_multi: true, //声明这张卡片更新后，对所有的接收人都生效
    },
    header: FAPI.tools.makeHeader('red', '一封挑战书'),
    elements: FAPI.tools.makeElements([
      `@${owner} 向群友发起挑战\n挑战难度为 【${difficulty}】`,
      `报名人数 *${users.length}/${limit}*`,
      ['note', ...users.map((user) => `![${user.username}](user.avatar)`],
      '**战吗？**',
      ['button', `!b:p[战啊！](${JSON.stringify({ difficulty, owner, limit, users, chat_id, })}`],
    ]),
  }
}
function makeNoticeCard(seriesDays) {
  if (!seriesDays) {
    return {
      header: FAPI.tools.makeHeader('green', '请记得提交哦！'),
      elements: FAPI.tools.makeElements([
        '加油！'
      ]),
    }
  }
  return {
    header: FAPI.tools.makeHeader('red', '今天还没提交哦！'),
    elements: FAPI.tools.makeElements([
      `你已经连续提交了 ${seriesDays} 天，坚持住哦！`,
      ['button', 
      `!b:p[知道了](${JSON.stringify({ type: 'subscribe', action: 'ok', seriesDays })})`,
      `!b[一小时后再提醒我](${JSON.stringify({ type: 'subscribe', action: 'delay', seriesDays })})`],
    ]),
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
  getRandomQuestion: async (difficulty) => {
    const randomSkip = Math.floor(Math.random() * 500)

    const variables = {
      categorySlug: 'algorithms',
      skip: randomSkip,
      limit: 1,
    }

    if (difficulty) {
      variables.filters.difficulty = difficulty
    }
    try {
      let res = await axios.post('https://leetcode.cn/graphql/', {
        query: queryConfig.randomQuestion,
        variables,
      })
      return res.data.data.problemsetQuestionList.questions[0]
    } catch (error) {
      console.log(`error:`, error)
    }
  },
  getQuestionDetail: async (titleSlug) => {
    let res = await axios.post('https://leetcode.cn/graphql/', {
      operationName: 'questionData',
      query: queryConfig.questionDetail,
      variables: {
        titleSlug,
      },
    })
    return res.data.data.question
  },
  submit: async ({ questionSlug, lang, question_id, typed_code }) => {
    const url = `https://leetcode.cn/problems/${questionSlug}/submit/`
    try {
      const res = await axios.post(url, {
        lang,
        question_id,
        typed_code,
      })
      return res.data.submission_id
    } catch (error) {
      return error
    }
  },
  checkSubmission: async (submission_id) => {
    const url = `https://leetcode.cn/submissions/detail/${submission_id}/check/`
    const res = await axios.get(url)
    return res.data
  },
}
