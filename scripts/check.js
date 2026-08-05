const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 自动定位到项目根目录下的 src
const baseDir = path.dirname(__dirname);
const srcDir = path.join(baseDir, 'src');
const files = ['t.main.js', 'p.main.js', 'm.main.js'];

console.log('=== 开始检测源码目录 src/ 下脚本可用性 ===\n');

files.forEach(file => {
  const filePath = path.join(srcDir, file);

  if (!fs.existsSync(filePath)) {
    console.log(`❌ 文件不存在: ${filePath}`);
    return;
  }

  const code = fs.readFileSync(filePath, 'utf-8');

  try {
    new vm.Script(code);
    console.log(`✅ [语法检查通过] ${file}`);
  } catch (err) {
    console.error(`❌ [语法错误] ${file}:`, err.message);
    return;
  }

  const grants = Array.from(code.matchAll(/\/\/\s*@grant\s+(.+)/g), m => m[1].trim());
  const matches = Array.from(code.matchAll(/\/\/\s*@(match|include)\s+(.+)/g), m => m[2].trim());

  console.log(`   └─ 规则 (@match): ${matches.length ? matches.join(', ') : '无'}`);
  console.log(`   └─ 权限 (@grant): ${grants.length ? grants.join(', ') : '无 (none)'}\n`);
});
