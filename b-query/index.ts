import cloud from '@/cloud-sdk'
import * as FSDK from 'feishu-sdk'
import * as BSDK from 'bilibili-sdk'
import * as dayjs from 'dayjs'

const isSameOrAfter = require('dayjs/plugin/isSameOrAfter')
dayjs.extend(isSameOrAfter)

const db = cloud.database()
const my_bili_uid = 15516023

exports.main = async function (ctx: FunctionContext) {
  // body, query 为请求参数, auth 是授权对象
  const { cookie, app_id, app_secret } = (await db.collection('Meta').doc('bili').get()).data
  const FAPI = await FSDK(app_id, app_secret)
  const { auth, body, query } = ctx
  const lastView = (await db.collection('Meta').doc('lastView').get())?.data?.time || 0

  const BAPI = BSDK(cookie, {id: my_bili_uid})

   // 获取缓存token或请求token
  let token = await db.collection('Meta').doc(`${app_id}_token`).get()
  if (token.data?.indate > new Date().getTime()) {
    token = token?.data
  } else {
    token = await FAPI.getTenantToken()
    token.indate = new Date().getTime() + token.expire * 1000
    await db.collection('Meta').doc(`${app_id}_token`).set(token)
  }
  FAPI.setToken(token)

  let unread = await BAPI.info.getUnread()
  unread = unread.reply
  let comments = []

  if (unread) {
    let list = await BAPI.comment.getComment()    
    comments = list.data.reverse().concat(comments)
  }

  for (let index = 0; index < comments.length; index++) {
    let item = comments[index]

    if (!lastView || (dayjs(item.ctime).isAfter(lastView) && item.mid !== my_bili_uid)) {
      db.collection('Meta').doc('lastView').set({ time: dayjs(item.ctime).valueOf() })

      let content = [
        [
          {
            tag: 'a',
            href: `https://www.bilibili.com/video/${item.bvid}`,
            text: item.title,
          },
        ],
      ]
      if (item.parent_info) {
        content.unshift([
          {
            tag: 'text',
            text: ` Re: ${item.parent_info.member.uname}: ${item.parent_info.content.message}`,
          },
        ])
      }

      let message = await FAPI.message.send('e6288gb4', {
        zh: {
          title: `${item.replier}: ${item.message}`,
          content
        }
      }, 'post')

      await db.collection('Message').doc(message.message_id).set({
        ...message,
        ...item
      })

      BAPI.info.markreadReply()
    }
  }

  return {}
}
