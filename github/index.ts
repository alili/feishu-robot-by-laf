

import cloud from '@/cloud-sdk'
import * as axios from 'axios'
import * as GitHub from 'github-api'
import * as FSDK from 'feishu-sdk'
import * as dayjs from 'dayjs'
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.tz.setDefault('Asia/Shanghai')

const getInfo = async () => {
  const gh = new GitHub({})

  let Repo = gh.getRepo('GreptimeTeam', 'greptimedb')
  let detail = await Repo.getDetails()
  let pr = await Repo.listPullRequests({})

  return {
    detail: detail.data,
    pr: pr.data,
  }
}

const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/cf18b3f4-aae5-419b-a4ec-bcd38c49775f'

exports.main = async function (ctx: FunctionContext) {
  let { detail, pr} = await getInfo()
  let FAPI = await FSDK()

  const questionMessage = await FAPI.message.sendCard(webhook, {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { content: `📅   greptimedb on GitHub [${dayjs.tz().format('HH:mm')}]`, tag: 'plain_text' },
    },
    elements: FAPI.tools.makeElements(
      [
        [
          `column_set`,
          [`**⭐  Star\n${detail.stargazers_count}**|center`],
          [`**🔥  Fork\n${detail.forks_count}**|center`],
          [`**🫵  Issue\n${detail.forks_count}**|center`],
          [`**🙏  PR\n${pr.length}**|center`],
        ],
      ],
      { withoutAt: true }
    ),
  })
  
  return {}
}
