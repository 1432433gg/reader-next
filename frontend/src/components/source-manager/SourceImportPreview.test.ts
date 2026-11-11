import { mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
import type { BookSource } from '../../types'
import { parseBookSourceImport } from '../../utils/sourceImport'
import SourceImportPreview from './SourceImportPreview.vue'

test('overwrite confirmation preserves both i64 bounds from the exact source list', async () => {
  const existing: BookSource = JSON.parse(
    '{"bookSourceName":"Existing","bookSourceUrl":"https://example.test/book","lastUpdateTime":"9223372036854775807","respondTime":"-9223372036854775808"}',
  )
  const entries = parseBookSourceImport(JSON.stringify([
    { bookSourceName: 'Replacement', bookSourceUrl: existing.bookSourceUrl, bookSourceGroup: 'Books' },
  ]), 'fixture')
  const confirm = vi.fn(() => true)
  vi.stubGlobal('confirm', confirm)
  const wrapper = mount(SourceImportPreview, {
    props: {
      visible: true, title: 'Import', entries, snapshotSources: [existing],
      currentSources: [existing], snapshotVersion: 1, notice: '', loading: false,
    },
    global: { stubs: { teleport: true } },
  })
  try {
    const inputs = wrapper.findAll('input[type="checkbox"]')
    await inputs[0].setValue(true)
    await inputs[1].setValue(true)
    await wrapper.get('button.primary').trigger('click')
    expect(confirm).toHaveBeenCalled()
    const emitted = wrapper.emitted('apply')
    expect(emitted).toHaveLength(1)
    const [[choices]] = JSON.parse(JSON.stringify(emitted))
    expect(choices).toMatchObject([{ action: 'overwrite', expectedExisting: existing }])
  } finally {
    wrapper.unmount()
    vi.unstubAllGlobals()
  }
})
