// server.js
require('dotenv').config();
const express = require('express');
const COS = require('cos-nodejs-sdk-v5');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// 存储桶配置
const ADMIN_BUCKET = 'talon-admin-1258609989';
const PUBLIC_BUCKET = 'talon-public-1258609989';
const REGION = 'ap-chongqing';
const COS_SECRET_ID = process.env.COS_SECRET_ID;
const COS_SECRET_KEY = process.env.COS_SECRET_KEY;

if (!COS_SECRET_ID || !COS_SECRET_KEY) {
  console.error('❌ 错误：COS_SECRET_ID 或 COS_SECRET_KEY 未在 .env 中设置！');
  process.exit(1);
}

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));

// ========================
// 工具：更新 user.json（管理员桶）
// ========================
async function updateUserListFile() {
  return new Promise((resolve, reject) => {
    cos.getBucket({ Bucket: ADMIN_BUCKET, Region: REGION, Prefix: '', Delimiter: '/' }, (err, data) => {
      if (err) {
        console.error('获取用户目录失败:', err);
        return reject(new Error('无法列出用户'));
      }
      const users = (data.CommonPrefixes || [])
        .map(prefix => prefix.Prefix.replace(/\/$/, ''))
        .filter(name => name.trim() !== '');
      cos.putObject({
        Bucket: ADMIN_BUCKET,
        Region: REGION,
        Key: 'user.json',
        Body: JSON.stringify(users, null, 2),
        ContentType: 'application/json; charset=utf-8'
      }, (putErr) => {
        if (putErr) {
          console.error('写入 user.json 失败:', putErr);
          reject(new Error('更新用户名单失败'));
        } else {
          console.log('✅ user.json 已更新:', users);
          resolve(users);
        }
      });
    });
  });
}

// ========================
// 接口：获取所有 .signature 文件（用于事务列表）
// 返回: [ "alice/alice.signature", "bob/update.signature", ... ]
// ========================
app.get('/api/transactions/list', async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      cos.getBucket({
        Bucket: PUBLIC_BUCKET,
        Region: REGION,
        Prefix: '',
        MaxKeys: 1000
      }, (err, data) => {
        if (err) return reject(err);
        const signatures = (data.Contents || [])
          .map(item => item.Key)
          .filter(key => key.endsWith('.signature') && !key.startsWith('recycle/'));
        resolve(signatures);
      });
    });
    res.json(result);
  } catch (error) {
    console.error('获取事务列表失败:', error);
    res.status(500).json({ error: '无法获取待审核事务' });
  }
});

// ========================
// 接口：仅获取指定 .signature 的原始内容（Base64）
// 路径如：/api/transaction/alice/alice.signature/raw
// 返回: { signature, sigKey }
// ========================
app.get('/api/transaction/:folder/:filename/raw', async (req, res) => {
  const { folder, filename } = req.params;
  if (!filename.endsWith('.signature')) {
    return res.status(400).json({ error: '仅支持 .signature 文件' });
  }
  const sigKey = `${folder}/${filename}`;

  try {
    const sigResult = await new Promise((resolve, reject) => {
      cos.getObject({ Bucket: PUBLIC_BUCKET, Region: REGION, Key: sigKey }, (err, data) => {
        if (err) return reject(err);
        resolve(data.Body);
      });
    });

    const signature = Buffer.isBuffer(sigResult) ? sigResult.toString('utf8').trim() : sigResult.trim();
    res.json({ signature, sigKey });
  } catch (error) {
    console.error('获取 .signature 失败:', error);
    if (error.statusCode === 404) {
      return res.status(404).json({ error: '签名文件不存在' });
    }
    res.status(500).json({ error: '获取签名数据失败' });
  }
});

// ========================
// 工具：移动对象到 recycle 目录
// ========================
async function moveToRecycle(keys) {
  const timestamp = Date.now().toString();
  const copyPromises = keys.map(key => {
    return new Promise((resolve, reject) => {
      cos.headObject({ Bucket: PUBLIC_BUCKET, Region: REGION, Key: key }, (headErr, headData) => {
        if (headErr) {
          if (headErr.statusCode === 404) {
            resolve(); // 不存在则跳过
            return;
          }
          return reject(headErr);
        }
        const contentType = headData.headers['content-type'] || 'application/octet-stream';
        cos.getObject({ Bucket: PUBLIC_BUCKET, Region: REGION, Key: key }, (getErr, getData) => {
          if (getErr) return reject(getErr);
          cos.putObject({
            Bucket: PUBLIC_BUCKET,
            Region: REGION,
            Key: `recycle/${timestamp}/${key}`,
            Body: getData.Body,
            ContentType: contentType
          }, (putErr) => {
            if (putErr) return reject(putErr);
            cos.deleteObject({ Bucket: PUBLIC_BUCKET, Region: REGION, Key: key }, (delErr) => {
              if (delErr) return reject(delErr);
              resolve();
            });
          });
        });
      });
    });
  });
  await Promise.all(copyPromises);
}

// ========================
// 提交事务：信任前端已验证，将 .json 移至 admin 桶，并回收原文件
// POST /api/transaction/:folder/:filename/commit
// ========================
app.post('/api/transaction/:folder/:filename/commit', async (req, res) => {
  const { folder, filename } = req.params;
  if (!filename.endsWith('.signature')) {
    return res.status(400).json({ error: '无效的签名文件名' });
  }
  const baseName = filename.slice(0, -11);
  const jsonKey = `${folder}/${baseName}.json`;
  const sigKey = `${folder}/${filename}`;

  try {
    // 1. 下载 .json
    const jsonBody = await new Promise((resolve, reject) => {
      cos.getObject({ Bucket: PUBLIC_BUCKET, Region: REGION, Key: jsonKey }, (err, data) => {
        if (err) return reject(err);
        resolve(data.Body);
      });
    });

    // 2. 上传到 admin 桶（覆盖）
    await new Promise((resolve, reject) => {
      cos.putObject({
        Bucket: ADMIN_BUCKET,
        Region: REGION,
        Key: `${folder}/${baseName}.json`,
        Body: jsonBody,
        ContentType: 'application/json; charset=utf-8'
      }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // 3. 回收 .json 和 .signature
    await moveToRecycle([jsonKey, sigKey]);

    // 4. 更新 user.json
    await updateUserListFile();

    res.json({ success: true, message: '事务已提交并归档至回收站' });
  } catch (error) {
    console.error('提交事务失败:', error);
    res.status(500).json({ error: '提交失败: ' + error.message });
  }
});

// ========================
// 驳回事务：仅回收文件
// POST /api/transaction/:folder/:filename/reject
// ========================
app.post('/api/transaction/:folder/:filename/reject', async (req, res) => {
  const { folder, filename } = req.params;
  const baseName = filename.slice(0, -11);
  const jsonKey = `${folder}/${baseName}.json`;
  const sigKey = `${folder}/${filename}`;

  try {
    await moveToRecycle([jsonKey, sigKey]);
    console.log(`✅ 事务 "${sigKey}" 已被驳回并移至回收站`);
    res.json({ success: true, message: '事务已驳回并归档' });
  } catch (error) {
    console.error('驳回事务失败:', error);
    res.status(500).json({ error: '驳回失败: ' + error.message });
  }
});

// ========================
// 用户管理接口（保持不变）
// ========================
app.get('/api/users/list', async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      cos.getObject({ Bucket: ADMIN_BUCKET, Region: REGION, Key: 'user.json' }, (err, data) => {
        if (err) {
          if (err.statusCode === 404) {
            updateUserListFile().then(users => resolve(users)).catch(reject);
          } else {
            reject(err);
          }
        } else {
          try {
            const str = Buffer.isBuffer(data.Body) ? data.Body.toString('utf8') : data.Body;
            const users = JSON.parse(str);
            resolve(users);
          } catch (e) {
            reject(new Error('user.json 解析失败'));
          }
        }
      });
    });
    res.json(result);
  } catch (error) {
    console.error('获取用户列表失败:', error.message);
    res.status(500).json({ error: '无法获取用户列表' });
  }
});

app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  if (!username) return res.status(400).json({ error: '用户名无效' });
  cos.getObject({ Bucket: ADMIN_BUCKET, Region: REGION, Key: `${username}/${username}.json` }, (err, data) => {
    if (err) {
      return res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.statusCode === 404 ? '用户不存在' : '读取失败' });
    }
    try {
      const str = Buffer.isBuffer(data.Body) ? data.Body.toString('utf8') : data.Body;
      res.json(JSON.parse(str));
    } catch (e) {
      res.status(500).json({ error: 'JSON 解析失败' });
    }
  });
});

app.post('/api/user/save', (req, res) => {
  const { username, data, isNew, encryptedPassword, updatePassword } = req.body;
  if (!username) return res.status(400).json({ error: '缺少用户名' });
  cos.putObject({
    Bucket: ADMIN_BUCKET,
    Region: REGION,
    Key: `${username}/${username}.json`,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json; charset=utf-8'
  }, (jsonErr) => {
    if (jsonErr) {
      console.error('JSON 上传失败:', jsonErr);
      return res.status(500).json({ error: '保存配置失败' });
    }
    if (updatePassword && encryptedPassword) {
      cos.putObject({
        Bucket: ADMIN_BUCKET,
        Region: REGION,
        Key: `${username}/${username}.pwd`,
        Body: encryptedPassword,
        ContentType: 'text/plain'
      }, (pwdErr) => {
        if (pwdErr) {
          console.warn('PWD 上传警告:', pwdErr);
        }
        updateUserListFile().finally(() => {
          res.json({ success: true });
        });
      });
    } else {
      updateUserListFile().finally(() => {
        res.json({ success: true });
      });
    }
  });
});

app.delete('/api/user/:username', (req, res) => {
  const { username } = req.params;
  if (!username) return res.status(400).json({ error: '用户名无效' });
  const keys = [`${username}/${username}.json`, `${username}/${username}.pwd`];
  let completed = 0;
  let hasError = false;
  keys.forEach(key => {
    cos.deleteObject({ Bucket: ADMIN_BUCKET, Region: REGION, Key: key }, (err) => {
      if (err && err.statusCode !== 404) {
        console.error(`删除 ${key} 失败:`, err);
        hasError = true;
      }
      if (++completed === keys.length) {
        if (hasError) {
          res.status(500).json({ error: '部分文件删除失败' });
        } else {
          updateUserListFile().finally(() => {
            res.json({ success: true });
          });
        }
      }
    });
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`✅ 服务器运行在 http://localhost:${PORT}`);
});