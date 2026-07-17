import { generateKeyPairSync } from 'crypto'

// 生成 ed25519 签名密钥对。把 GEWU_SIGNING_KEY 写入 .env 即启用 manifest 签名。
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const priv = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64')
const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64')
console.log('GEWU_SIGNING_KEY=' + priv)
console.log('# 公钥(参考，由 /v1/keys 自动派生): ' + pub)
process.exit(0)
