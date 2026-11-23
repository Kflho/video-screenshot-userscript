/**
 * 油猴脚本的 smoke 测试：**不启动浏览器**，只保证"文件还是合法脚本 + 元数据没丢 + 不碰页面 DOM"。
 *
 * 为什么只做这些：这个仓库是单文件 userscript，没有构建链；真正的行为（抓帧、跨域 iframe、
 * 剪贴板权限）只能在浏览器里验。这里挡住的是最低级的错：改完语法坏了、元数据块被删、
 * `@match`/`@grant` 丢了 —— 这些在 Tampermonkey 里表现为"整个脚本不加载"，最难排查。
 *
 * 2026-11 追加一条硬约束（有真实事故）：**内联按钮绝不能插进页面 DOM**。
 * B 站是服务端渲染 + 前端水合，脚本在 document-idle 往 `.pubdate-ip` 后面插 `<button>`，
 * 水合找注释锚点就错位，`appendChild` 打到注释节点上抛 HierarchyRequestError，
 * 整页水合中断 —— 现象是「只有播放器，其余全空白」。第 4、5 组测试用最小 DOM 替身盯着这件事。
 *
 * 2026-11 再追加：**全屏 / 网页全屏时不显示按钮**（第 6 组）。全屏画面就是视频本身，
 * 按钮只会挡画面；网页全屏（B 站那种 CSS 铺满，不走 Fullscreen API）按「画面铺满视口」判。
 * 快捷键 `Ctrl+Shift+S` 仍在，这两种情况下都用它截图。
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

// ---------------------------------------------------------------- 4. 硬约束
test('源码里不再有"往页面 DOM 插节点"的写法', () => {
	for (const api of ['insertAdjacentElement', 'insertBefore', 'replaceChild', 'replaceChildren']) {
		assert.doesNotMatch(
			source,
			new RegExp(`\\b${api}\\s*\\(`),
			`${api}() 会把节点插进 SSR 出来的 DOM，水合会崩（B 站空白页事故），别再加回来`
		);
	}
});

// ------------------------------------------------- 5. 行为：按钮只挂 body
/**
 * 最小 DOM 替身：够跑 init() 那条路径即可，重点记录"节点插到了哪".
 *
 * @param {{hostname?: string, video?: boolean}} [options]
 *   hostname —— 站点域名，决定命中站点规则（内联按钮）还是走通用悬浮按钮；
 *   video —— 在 body 里放一个可截图的 <video>（走悬浮按钮那条路径时需要）。
 */
function makeDomStub(options = {}) {
	const record = { appendChild: [], insertAdjacent: 0 };
	const listeners = { document: [], window: [] };
	const hostname = options.hostname || 'www.bilibili.com';

	function makeEl(tag) {
		const el = {
			tagName: String(tag || 'div').toUpperCase(),
			id: '',
			className: '',
			textContent: '',
			children: [],
			parentNode: null,
			isConnected: true,
			style: {},
			dataset: {},
			offsetWidth: 64,
			offsetHeight: 28,
			rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
			appendChild(child) {
				child.parentNode = el;
				el.children.push(child);
				record.appendChild.push({ parent: el, child });
				return child;
			},
			remove() {
				if (!el.parentNode) return;
				el.parentNode.children = el.parentNode.children.filter(c => c !== el);
				el.parentNode = null;
			},
			insertAdjacentElement() {
				record.insertAdjacent += 1;
				throw new Error('insertAdjacentElement 被调用：会破坏 SSR 水合');
			},
			addEventListener() {},
			removeEventListener() {},
			getBoundingClientRect() {
				return el.rect;
			},
			querySelector() {
				return null;
			},
			contains() {
				return false;
			},
			setAttribute() {},
			getAttribute() {
				return null;
			}
		};
		return el;
	}

	const html = makeEl('html');
	const body = makeEl('body');
	html.appendChild(body);

	// 模拟 B 站首屏：SSR 出来的 div.info 里有一个 span.pubdate-ip（水合锚点）
	const app = makeEl('div');
	app.id = 'app';
	body.appendChild(app);
	const info = makeEl('div');
	app.appendChild(info);
	const anchor = makeEl('span');
	anchor.className = 'pubdate-ip';
	anchor.rect = { left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20 };
	info.appendChild(anchor);

	// 走悬浮按钮的站点没有水合锚点，只有 <video>：放一个可截图的（面积/就绪态都够）。
	// 默认高度 600（占视口 800 的 75%），不算「网页全屏」；用例里改 rect 来模拟铺满。
	let video = null;
	if (options.video) {
		video = makeEl('video');
		video.videoWidth = 1920;
		video.videoHeight = 1080;
		video.readyState = 4;
		video.paused = false;
		video.rect = { left: 0, top: 0, right: 1280, bottom: 600, width: 1280, height: 600 };
		body.appendChild(video);
	}

	function walk(el, fn) {
		fn(el);
		for (const child of el.children) walk(child, fn);
	}

	// 只认测试用得到的几种选择器：'video'、'*'、'.class'
	function collectBySelector(selector) {
		const all = [];
		walk(body, el => all.push(el));
		return all.filter(el => {
			if (selector === '*') return true;
			if (selector === 'video') return el.tagName === 'VIDEO';
			if (selector.charAt(0) === '.') return String(el.className || '').split(/\s+/).indexOf(selector.slice(1)) !== -1;
			return false;
		});
	}

	function findById(id) {
		let found = null;
		walk(body, el => {
			if (!found && el.id === id) found = el;
		});
		return found;
	}

	const document = {
		body,
		head: makeEl('head'),
		documentElement: html,
		fullscreenElement: null,
		visibilityState: 'visible',
		createElement: tag => makeEl(tag),
		getElementById: findById,
		querySelector: selector => (selector === '.pubdate-ip' ? anchor : null),
		querySelectorAll: selector => collectBySelector(selector),
		addEventListener(type, fn) {
			listeners.document.push({ type, fn });
		},
		hasFocus() {
			return true;
		}
	};

	const window = {
		location: { hostname, href: 'https://' + hostname + '/' },
		innerWidth: 1280,
		innerHeight: 800,
		frames: [],
		addEventListener(type, fn) {
			listeners.window.push({ type, fn });
		},
		removeEventListener() {},
		getComputedStyle() {
			return {};
		},
		postMessage() {}
	};
	window.top = window;
	window.parent = window;

	const sandbox = {
		window,
		document,
		navigator: { userAgent: 'node-smoke', clipboard: undefined },
		console: { log() {} },
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
		// 立即执行：watcher 里用 rAF 合并刷新，测试里同步跑才能断言
		requestAnimationFrame: fn => {
			fn();
			return 0;
		},
		cancelAnimationFrame: () => {}
	};
	sandbox.globalThis = sandbox;

	// 把事件派给已注册的监听（document 和 window 都算）
	function fire(type) {
		for (const l of listeners.document.concat(listeners.window)) {
			if (l.type === type) l.fn();
		}
	}

	// 模拟进出全屏：先设 fullscreenElement，再派 fullscreenchange
	function setFullscreen(el) {
		document.fullscreenElement = el;
		fire('fullscreenchange');
		fire('webkitfullscreenchange');
	}

	return { sandbox, record, document, body, app, info, anchor, video, findById, fire, setFullscreen };
}

test('内联按钮挂在 body 上，不往页面的 SSR 节点里插东西', () => {
	const dom = makeDomStub();
	vm.createContext(dom.sandbox);
	new vm.Script(source, { filename: FILE }).runInContext(dom.sandbox);

	assert.equal(dom.record.insertAdjacent, 0, '不该调用 insertAdjacentElement');
	assert.equal(dom.info.children.length, 1, '锚点的父节点不该多出兄弟节点（水合会被打乱）');
	assert.equal(dom.anchor.parentNode, dom.info, '锚点不该被移动');

	const btn = dom.findById('videoScreenshotBtn');
	assert.ok(btn, '按钮没被创建');
	assert.equal(btn.parentNode, dom.body, '按钮应该挂在 body 上（#app 之外）');
	assert.equal(btn.style.position, 'fixed', '按钮应是 fixed 浮层，不参与页面布局');
});

test('内联按钮贴在锚点右侧（纯算位置，不动 DOM）', () => {
	const dom = makeDomStub();
	vm.createContext(dom.sandbox);
	new vm.Script(source, { filename: FILE }).runInContext(dom.sandbox);

	const btn = dom.findById('videoScreenshotBtn');
	assert.ok(btn, '按钮没被创建');
	// 锚点 right=300、高 20；按钮 64x28；间距 8 → left=308、top=196
	assert.equal(btn.style.left, '308px');
	assert.equal(btn.style.top, '196px');
});

// ------------------------------------------------- 6. 全屏收起按钮
test('内联按钮在全屏时收起，退出全屏回到锚点右侧', () => {
	const dom = makeDomStub();
	vm.createContext(dom.sandbox);
	new vm.Script(source, { filename: FILE }).runInContext(dom.sandbox);

	const btn = dom.findById('videoScreenshotBtn');
	assert.notEqual(btn.style.display, 'none', '非全屏时应显示按钮');

	dom.setFullscreen(dom.app);
	assert.equal(btn.style.display, 'none', '全屏时应收起内联按钮');

	dom.setFullscreen(null);
	assert.notEqual(btn.style.display, 'none', '退出全屏后按钮应重新出现');
	assert.equal(btn.style.left, '308px', '退出全屏后回到锚点右侧');
});

test('进页面时已在全屏：按钮直接隐藏，且不往全屏元素里插节点', () => {
	const dom = makeDomStub();
	dom.document.fullscreenElement = dom.app;   // 脚本运行时页面已经是全屏
	vm.createContext(dom.sandbox);
	new vm.Script(source, { filename: FILE }).runInContext(dom.sandbox);

	const btn = dom.findById('videoScreenshotBtn');
	assert.ok(btn, '按钮应已创建（退出全屏后要用）');
	assert.equal(btn.style.display, 'none', '全屏下创建也应隐藏');
	assert.equal(btn.parentNode, dom.body, '按钮只挂 body，不进全屏元素');
	assert.equal(dom.app.children.length, 1, '全屏元素里不该多出节点');
});

test('悬浮按钮在全屏时收起，退出全屏回到视频角落', () => {
	const dom = makeDomStub({ hostname: 'example.com', video: true });
	vm.createContext(dom.sandbox);
	new vm.Script(source, { filename: FILE }).runInContext(dom.sandbox);

	const btn = dom.findById('videoScreenshotBtn');
	assert.ok(btn, '悬浮按钮没被创建');
	assert.notEqual(btn.style.display, 'none', '非全屏时应显示悬浮按钮');
	// 视频 1280x600 贴视口左上；默认 top-right、inset 12、按钮 64x28
	assert.equal(btn.style.left, '1204px');
	assert.equal(btn.style.top, '12px');

	dom.setFullscreen(dom.body);
	assert.equal(btn.style.display, 'none', '全屏时应收起悬浮按钮');

	dom.setFullscreen(null);
	assert.notEqual(btn.style.display, 'none', '退出全屏后悬浮按钮应重新出现');
});

test('网页全屏（CSS 铺满视口，无 Fullscreen API）时悬浮按钮也收起', () => {
	const dom = makeDomStub({ hostname: 'example.com', video: true });
	vm.createContext(dom.sandbox);
	new vm.Script(source, { filename: FILE }).runInContext(dom.sandbox);

	const btn = dom.findById('videoScreenshotBtn');
	assert.notEqual(btn.style.display, 'none', '初始画面没铺满，应显示按钮');

	// 站点用 CSS 把播放器铺满：video 盒子 = 视口，fullscreenElement 仍是 null
	dom.video.rect = { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 };
	dom.fire('resize');
	assert.equal(btn.style.display, 'none', '网页全屏应收起悬浮按钮');

	dom.video.rect = { left: 0, top: 0, right: 1280, bottom: 600, width: 1280, height: 600 };
	dom.fire('resize');
	assert.notEqual(btn.style.display, 'none', '退出网页全屏后悬浮按钮应重新出现');
});

test('网页全屏时内联按钮也收起（铺满判据对站点规则同样生效）', () => {
	const dom = makeDomStub({ video: true });
	vm.createContext(dom.sandbox);
	new vm.Script(source, { filename: FILE }).runInContext(dom.sandbox);

	const btn = dom.findById('videoScreenshotBtn');
	assert.notEqual(btn.style.display, 'none', '初始画面没铺满，应显示按钮');

	dom.video.rect = { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 };
	dom.fire('resize');
	assert.equal(btn.style.display, 'none', '网页全屏应收起内联按钮');

	dom.video.rect = { left: 0, top: 0, right: 1280, bottom: 600, width: 1280, height: 600 };
	dom.fire('resize');
	assert.notEqual(btn.style.display, 'none', '退出网页全屏后内联按钮应重新出现');
	assert.equal(btn.style.left, '308px', '回来后仍贴在锚点右侧');
});
