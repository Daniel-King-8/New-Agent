import { hashPassword, randomPassword, saveConfig } from './config.mjs';

const password = process.argv[2] || randomPassword(16);
saveConfig({ auth: { passwordHash: hashPassword(password), mustChange: true } });
console.log('==============================================');
console.log(`新的后台密码: ${password}`);
console.log('请登录后立即修改密码。');
console.log('==============================================');
