import cloud from '@/cloud-sdk'
import * as dayjs from 'dayjs'
import * as FSDK from 'feishu-sdk'

const db = cloud.database()
let FAPI

exports.main = async function (ctx: FunctionContext) {
  // body, query 为请求参数, auth 是授权对象
  const { auth, body, query } = ctx
  await init(body)
  // 数据库操作
  return
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
  const { key, secret } = (await db.collection('Meta').doc('github_app').get()).data
  FAPI = await FSDK(key, secret, { noCache: true })

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
  if (body?.header?.event_id) {
    const _event = (await db.collection('Events').doc(body.header.event_id).get()).data
    if (_event) {
      return 'has event'
    } else {
      db.collection('Events').doc(body.header.event_id).set(body.event.message)
    }
  }
}
