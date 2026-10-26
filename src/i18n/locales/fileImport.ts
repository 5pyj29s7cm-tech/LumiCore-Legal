export const fileImportCopy = {
  zh: { upload: '选择文件', drop: '将文件拖到这里，或点击选择文件', failed: '以下文件未导入，请重新选择：', incomplete: '未读取完整文本，请检查文件或先进行 OCR。' },
  en: { upload: 'Choose files', drop: 'Drop files here, or choose files', failed: 'These files were not imported. Select them again:', incomplete: 'Full text was not read. Check the file or run OCR first.' },
};

export const materialImportCopy = {
  zh: {
    title: '材料入库', description: '将文件或粘贴的完整正文导入知识库，按所选材料类型保存。',
    import: '导入材料', defaultTitle: '未命名材料', materialType: '材料类型', content: '材料完整正文', placeholder: '粘贴材料完整正文，或选择文件',
    types: { case_material: '普通材料', judgment: '裁判文书', statute: '法律法规', contract: '合同或协议', evidence: '证据', pleading: '诉讼文书', transcript: '笔录或转写', bid_template: '招投标材料', legal_opinion: '法律意见', research_note: '检索笔记', company_report: '企业信息' },
  },
  en: {
    title: 'Import materials', description: 'Import complete files or pasted text into the knowledge base using the selected material type.',
    import: 'Import materials', defaultTitle: 'Untitled material', materialType: 'Material type', content: 'Complete material text', placeholder: 'Paste the complete material text, or choose files',
    types: { case_material: 'General material', judgment: 'Judgment', statute: 'Statute', contract: 'Contract or agreement', evidence: 'Evidence', pleading: 'Pleading', transcript: 'Transcript', bid_template: 'Tender material', legal_opinion: 'Legal opinion', research_note: 'Research note', company_report: 'Company information' },
  },
};
