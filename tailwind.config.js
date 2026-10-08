/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0a0a0a',
          1: '#141414',
          2: '#1e1e1e',
          3: '#282828',
          4: '#333333',
        },
        accent: {
          DEFAULT: '#d4a574',
          dim: '#a67c52',
          bright: '#e8c49a',
        },
        // —— 设计 spec 语义色（docs/design/vixel-design-spec.html）——
        // 文字层级：主文 / 次要 / 辅助 / 禁用；ghost 只给装饰性图标，不用于可读文字
        ink: {
          DEFAULT: 'rgb(255 255 255 / 0.88)',
          2: 'rgb(255 255 255 / 0.60)',
          3: 'rgb(255 255 255 / 0.38)',
          4: 'rgb(255 255 255 / 0.24)',
          ghost: 'rgb(255 255 255 / 0.12)',
        },
        // 分隔线 / 控件描边 / 聚焦描边
        line: {
          DEFAULT: 'rgb(255 255 255 / 0.07)',
          strong: 'rgb(255 255 255 / 0.12)',
          heavy: 'rgb(255 255 255 / 0.20)',
        },
        // 控件填充：静止 / 悬停 / 按下·选中 / 媒体上的强填充
        fill: {
          DEFAULT: 'rgb(255 255 255 / 0.05)',
          hover: 'rgb(255 255 255 / 0.08)',
          active: 'rgb(255 255 255 / 0.12)',
          strong: 'rgb(255 255 255 / 0.22)',
        },
        // 状态色（macOS 系统色深色版）；hex 定义，保留 /xx 透明度修饰
        ok: '#30d158',
        warn: '#ffd60a',
        bad: '#ff453a',
        info: '#64d2ff',
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
