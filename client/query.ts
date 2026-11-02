/** 状态快照的 react-query key:主界面轮询,其他组件操作后据此失效刷新。 */
export const STATE_QUERY_KEY = ["superagent", "state"] as const;
