/**
 * 油猴脚本的 smoke 测试：**不启动浏览器**，只保证"文件还是合法脚本 + 元数据没丢"。
 *
 * 为什么只做这些：这个仓库是单文件 userscript，没有构建链；真正的行为（抓帧、跨域 iframe、
 * 剪贴板权限）只能在浏览器里验。这里挡住的是最低级的错：改完语法坏了、元数据块被删、
 * `@match`/`@grant` 丢了 —— 这些在 Tampermonkey 里表现为"整个脚本不加载"，最难排查。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = path.join(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'video-screenshot-userscript.js');
const source = fs.readFileSync(FILE, 'utf8');

test('语法能解析（Node 的 parser，等价于"至少不是坏文件"）', () => {
	assert.doesNotThrow(() => new vm.Script(source, { filename: FILE }));
});

test('UserScript 元数据块完整', () => {
	const meta = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)?.[1] ?? '';
	assert.notEqual(meta, '', '缺少 ==UserScript== 元数据块');
	for (const key of ['@name', '@version', '@match', '@grant', '@run-at']) {
		const pattern = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\S+`);
		assert.match(meta, pattern, `缺少 ${key}`);
	}
	assert.match(meta, /@version\s+\d+\.\d+\.\d+/, '@version 应是 x.y.z');
});

test('关键入口还在（快捷键 / 剪贴板 / 抓帧）', () => {
	assert.match(source, /Ctrl\+Shift\+S|ctrlKey/i, '快捷键相关代码不见了');
	assert.match(source, /clipboard/i, '剪贴板相关代码不见了');
	assert.match(source, /captureStream|drawImage|toBlob/i, '抓帧相关代码不见了');
});
