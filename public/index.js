// index.js
const COS = require('cos-nodejs-sdk-v5');
require('dotenv').config();
const cos = new COS({
  SecretId: process.env.SecretId,
  SecretKey: process.env.SecretKey,
});

cos.getService(function (err, data) {
  if (err) {
    console.error('请求出错:', err);
  } else {
    console.log('存储桶列表:', data.Buckets);
  }
});