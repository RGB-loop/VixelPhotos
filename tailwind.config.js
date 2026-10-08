/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      // 颜色全部走 CSS 变量（定义在 globals.css），深色 / 浅色两套值随系统外观切换。
      // 需要 /xx 透明度修饰的（accent、状态色）用 "R G B" 通道变量
      colors: {
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          4: 'var(--surface-4)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          dim: 'rgb(var(--accent-dim) / <alpha-value>)',
          bright: 'rgb(var(--accent-bright) / <alpha-value>)',
          // 选中行 / 选中 chip 的底色
          fill: 'var(--accent-fill)',
        },
        // 外壳表面：内容区 / 侧边栏·检查器 / 工具栏·状态栏 / 浮层·抽屉
        canvas: 'var(--canvas)',
        sidebar: 'var(--sidebar)',
        bar: 'var(--bar)',
        raised: 'var(--raised)',
        // —— 设计 spec 语义色（docs/design/vixel-design-spec.html）——
        // 文字层级：主文 / 次要 / 辅助 / 禁用；ghost 只给装饰性图标，不用于可读文字
        ink: {
          DEFAULT: 'var(--ink)',
          2: 'var(--ink-2)',
          3: 'var(--ink-3)',
          4: 'var(--ink-4)',
          ghost: 'var(--ink-ghost)',
        },
        // 分隔线 / 控件描边 / 聚焦描边
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
          heavy: 'var(--line-heavy)',
        },
        // 控件填充：静止 / 悬停 / 按下·选中 / 媒体上的强填充
        fill: {
          DEFAULT: 'var(--fill)',
          hover: 'var(--fill-hover)',
          active: 'var(--fill-active)',
          strong: 'var(--fill-strong)',
        },
        // 状态色（macOS 系统色，深浅两版）
        ok: 'rgb(var(--ok) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        bad: 'rgb(var(--bad) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
      },
      fontSize: {
        micro: ['10px', '13px'],
        caption: ['11px', '14px'],
        callout: ['12px', '16px'],
        body: ['13px', '18px'],
        headline: ['13px', { lineHeight: '18px', fontWeight: '600' }],
        title: ['17px', { lineHeight: '22px', fontWeight: '600' }],
        'title-lg': ['22px', { lineHeight: '28px', fontWeight: '600' }],
      },
      transitionDuration: {
        fast: '120ms',
        panel: '200ms',
        view: '280ms',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
