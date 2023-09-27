// @see https://docs.aircode.io/guide/functions/
const aircode = require('aircode');
const u2b  = require('image-to-base64')
const FSDK = require('feishu-sdk');

module.exports = async function (params, context) {
  const FAPI = await FSDK(process.env.app_id, process.env.app_secret)
  const base64 = await u2b(params.url)
  const text = await FAPI.ai.ocr(base64)
  
  return {
    text
  };
};
