import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 这个版本去掉了所有 AI 功能：确保前端源码里不再引用 AI 接口和组件
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return listSourceFiles(path)
    return /\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
  })
}

const files = listSourceFiles(resolve(process.cwd(), 'src'))

describe('AI features are removed', () => {
  it.each([
    ['/reader3/ai/', /\/reader3\/ai\//],
    ['AI store', /stores\/aiBook/],
    ['chapter summary', /chapterSummary|ChapterSummary/],
    ['OpenAI speech', /openai|OpenAI/],
    ['AI book route', /ai-book/],
  ])('no source file references %s', (_label, pattern) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})
