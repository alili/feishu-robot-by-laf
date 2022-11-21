import cloud from '@/cloud-sdk'
import * as axios from "axois"
import * as FSDK from 'feishu-sdk'


exports.main = async function (ctx: FunctionContext) {
  // body, query 为请求参数, auth 是授权对象
  const { auth, body, query } = ctx
  // app_token: bascngugf5wIbODzT0hxtDTl64e
  // table_id: tbldt4amzaq6boO2

  const FAPI = await FSDK('cli_a27af43160f8d00c', 'etF4fNxZAF7NEVuKA8EzmfrqR27qGnYX')
  const file = await FAPI.bitable.getRecords('bascngugf5wIbODzT0hxtDTl64e', 'tbldt4amzaq6boO2', 500, '')

  const { data: { items } } = file
  const item = items[Math.floor(Math.random() * items.length)].fields

  let message = {
    header: FAPI.tools.makeHeader('green', '今天读这篇内容'),
    elements: FAPI.tools.makeElements([
      `**[标题]**: ${item.标题}`,
      `**[链接]**： [${item.链接.text}](${item.链接.link})`,
      `**[为什么值得你读]**： ${item.推荐语}`,
    ])
  }

  await FAPI.message.sendCard('e6288gb4', message)

  FAPI.event.add('cangshu', async (msg) {  
    console.log(msg)
  })

  FAPI.event.listen('cangshu')

  return {
    item
  }
}
