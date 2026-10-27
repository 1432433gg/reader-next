import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/reader-next/',
  title: 'Reader',
  description: '自用的阅读 3.0 Rust 服务端，自动检查新章节',

  head: [
    ['meta', { name: 'theme-color', content: '#111827' }],
    ['meta', { property: 'og:title', content: 'Reader' }],
    ['meta', { property: 'og:description', content: '自用的阅读 3.0 Rust 服务端，自动检查新章节' }]
  ],

  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/' },
      { text: 'API', link: '/api/' },
      { text: '书源', link: '/book-source/' },
      { text: '部署', link: '/deploy/docker' },
      { text: 'GitHub', link: 'https://github.com/1432433gg/reader-next' }
    ],

    sidebar: {
      '/guide/': [
        {
          text: '入门',
          items: [
            { text: '简介', link: '/guide/' },
            { text: '快速开始', link: '/guide/quickstart' },
            { text: '新章节自动检查', link: '/guide/chapter-update' },
            { text: '配置', link: '/guide/configuration' },
            { text: '功能特性', link: '/guide/features' },
            { text: '用户手册', link: '/guide/user-manual' },
            { text: '测试流程', link: '/guide/testing' }
          ]
        },
      ],
      '/api/': [
        {
          text: 'API参考',
          items: [
            { text: '概述', link: '/api/' },
            { text: '书源管理', link: '/api/book-source' },
            { text: '书籍搜索', link: '/api/search' },
            { text: '章节内容', link: '/api/chapter' },
            { text: '书架管理', link: '/api/bookshelf' },
            { text: '书签管理', link: '/api/bookmark' },
            { text: '用户管理', link: '/api/user' },
            { text: 'RSS订阅', link: '/api/rss' },
            { text: 'WebDAV 备份', link: '/api/webdav' },
            { text: '内容过滤', link: '/api/replace-rule' },
            { text: '应用更新', link: '/api/update' }
          ]
        }
      ],
      '/deploy/': [
        {
          text: '部署',
          items: [
            { text: 'Docker 部署与发版', link: '/deploy/docker' }
          ]
        }
      ],
      '/book-source/': [
        {
          text: '书源开发',
          items: [
            { text: '概述', link: '/book-source/' },
            { text: '规则语法', link: '/book-source/rules' },
            { text: '搜索规则', link: '/book-source/search-rule' },
            { text: '书籍信息', link: '/book-source/book-info' },
            { text: '目录规则', link: '/book-source/toc-rule' },
            { text: '正文规则', link: '/book-source/content-rule' },
            { text: 'JavaScript', link: '/book-source/javascript' },
            { text: '解析器实现规格', link: '/book-source/spec' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/1432433gg/reader-next' }
    ],

    editLink: {
      pattern: 'https://github.com/1432433gg/reader-next/edit/main/docs/:path'
    }
  }
})
