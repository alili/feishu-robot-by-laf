import cloud from '@/cloud-sdk'
import * as FSDK from 'feishu-sdk'
import * as BSDK from 'bilibili-sdk'

const MY_SELF = '15516023'
const UID = 'oc_0d49275ee48bf3583c3818a96ff5106a'
const sleep = function (t) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      return resolve(true)
    }, t)
  })
}

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
    event: { message, sender },
  } = body

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
  const BAPI = BSDK(cookie, { id: my_bili_uid })

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

  // 不缓存
  // FAPI.setToken((await FAPI.getTenantToken()).tenant_access_token)

  const msg = JSON.parse(message.content).text

  await FAPI.event.im_message_receive_v1(body, async (args) => {
    if (/^开播/.test(args.msg)) {
      let res = await BAPI.updateLiveRoomName(args.msg.replace('开播', '').trim() || '直播写代码')
      console.log(res)
      let live = await BAPI.startLive()
      console.log(live)
      await FAPI.message.sendText(UID, `http://live.bilibili.com/23742138 已开播`)
    } else if (args.msg === '下播') {
      await BAPI.stopLive()
      await FAPI.message.sendText(UID, `http://live.bilibili.com/23742138 已下播`)
    } else if (/^:/.test(args.msg)) {
      let { room_id } = await BAPI.getRoomId(args.msg.replace(':', ''))
      let roomName = await BAPI.getLiveName(room_id)
      let sendMessage = await FAPI.sendTextMessage(args.user_id, `当前直播间：${roomName}(${room_id})`)

      await FAPI.message.putMessageTop(sendMessage.chat_id, sendMessage.message_id)
      await db.collection('Meta').doc('currentRoom').set({ room_id })
    } else {
      const {
        data: { room_id },
      } = await db.collection('Meta').doc('currentRoom').get()

      for (let index = 0; index < msg.length / 20; index++) {
        await BAPI.sendDanmu(room_id, args.msg.slice(index * 20, (index + 1) * 20))
        await sleep(1000)
      }
      return {}
    }
  })
  return { msg }
}
