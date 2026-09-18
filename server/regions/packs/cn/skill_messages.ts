export const CN_TIMER_SKILL_METADATA = {
  displayName: '临时倒计时',
  description: '仅检查当前技能进程内的倒计时，不发送提醒，进程关闭后记录会丢失。需要到时通知请使用主程序提醒功能（add_reminder）。',
};

export const CN_LEGAL_REASONING_DRAFT_MESSAGES = {
  ready: '底稿结构已齐，法律结论仍待复核',
  missing: '尚未形成完整法律分析底稿',
};

export const CN_LEGAL_WORKFLOW_MESSAGES = {
  incomplete: '本次仅生成部分结果或结构模板，尚未完成正文及来源核验。',
  cancelled: '本次法律工具执行已取消。',
  failed: '本次法律工具执行未完成，请检查后重试。',
};
