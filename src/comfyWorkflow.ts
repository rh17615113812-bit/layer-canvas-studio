/** Clone only the background job, leaving region prompts and model parameters intact. */
export function backgroundComfyWorkflow(workflow: Record<string, unknown> | undefined, nodeId = '', resolution = 0) {
  if (!nodeId.trim()) return workflow;
  if (!workflow) throw new Error('设置背景 resolution 前，请选择 API 工作流 JSON。');
  if (!Number.isFinite(resolution) || resolution < 0) throw new Error('背景 resolution 必须是非负数。');
  const copy = structuredClone(workflow);
  const configuredNode = copy[nodeId.trim()] as { inputs?: Record<string, unknown> } | undefined;
  const resolutionNodes = Object.entries(copy).filter(([, value]) => {
    const inputs = (value as { inputs?: Record<string, unknown> } | undefined)?.inputs;
    return typeof inputs?.resolution === 'number';
  });
  const node = configuredNode?.inputs && typeof configuredNode.inputs.resolution === 'number'
    ? configuredNode
    : resolutionNodes.length === 1
      ? resolutionNodes[0][1] as { inputs: Record<string, unknown> }
      : undefined;
  // Resolution is an optional workflow input. A stale/default node ID should not
  // block the background prompt when the selected workflow exposes no such input.
  if (!node?.inputs) {
    if (!resolutionNodes.length) return copy;
    throw new Error(`工作流中有多个 resolution 参数节点，无法确定背景节点；请填写正确的节点 ID（当前为 ${nodeId}）。`);
  }
  node.inputs.resolution = resolution;
  return copy;
}
