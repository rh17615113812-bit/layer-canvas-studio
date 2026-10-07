/** Clone only the background job, leaving region prompts and model parameters intact. */
export function backgroundComfyWorkflow(workflow: Record<string, unknown> | undefined, nodeId = '', resolution = 0) {
  if (!nodeId.trim()) return workflow;
  if (!workflow) throw new Error('设置背景 resolution 前，请选择 API 工作流 JSON。');
  if (!Number.isFinite(resolution) || resolution < 0) throw new Error('背景 resolution 必须是非负数。');
  const copy = structuredClone(workflow);
  const node = copy[nodeId.trim()] as { inputs?: Record<string, unknown> } | undefined;
  if (!node?.inputs || typeof node.inputs.resolution !== 'number') throw new Error(`背景参数节点 ${nodeId} 不存在或没有 resolution 字段。`);
  node.inputs.resolution = resolution;
  return copy;
}
