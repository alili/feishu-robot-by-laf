import cloud from '@/cloud-sdk'
import * as FSDK from 'feishu-sdk'
import * as BSDK from 'bilibili-sdk'

const db = cloud.database()

exports.main = async function (ctx: FunctionContext) {
  // body, query 为请求参数, auth 是授权对象
  const { auth, body, query } = ctx

    // 飞书事件监听绑定
  if (body.challenge) {
    return {
      challenge: body.challenge,
    }
  }
  const {
    header,
    event,
    event: { message, sender },
  } = body
  console.log(message)

  // 避免冗余事件
  const _event = header.event_id && (await db.collection('Events').doc(header.event_id).get()).data
  if (_event) {
    return {}
  } else {
    db.collection('Events').doc(header.event_id).set(message)
  }

  // 初始化API
  const { cookie, app_id, app_secret } = (await db.collection('Meta').doc('bili').get()).data
  const FAPI = await FSDK(app_id, app_secret)
  const BAPI = BSDK(cookie, {id: '15516023'})

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

  FAPI.event.add('notice', async () => {
    if (message.parent_id) {
      let comment = await db.collection('Message').doc(message.parent_id).get()
      console.log(comment.data,msg)       
      await BAPI.comment.replyComment(comment.data, msg)
      await BAPI.comment.setLike(comment.data)
    }
      let { message_id } = event
      let comment = await db.collection('Message').doc(message_id).get()
      await BAPI.comment.setLike(comment.data)
  })

  await FAPI.event.listen(body, 'notice')

  return {}
}
