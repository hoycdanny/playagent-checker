#!/usr/bin/env node
/**
 * 刪除 UI-TARS endpoint(省成本用 —— g6e.xlarge 常駐約 US$1.86/hr)。
 * 用法:node teardownUitars.mjs <endpointName>
 *      或 node teardownUitars.mjs --all-ui-tars   刪所有名字以 ui-tars- 開頭的 endpoint
 * 也會一併刪對應的 EndpointConfig 與 Model(靠命名慣例 ui-tars-<ts> / -config- / -model-)。
 */
import {
  SageMakerClient, ListEndpointsCommand, DescribeEndpointConfigCommand,
  DeleteEndpointCommand, DeleteEndpointConfigCommand, DeleteModelCommand,
} from '@aws-sdk/client-sagemaker';

const REGION = process.env.PA_SM_REGION || 'us-east-2';
const sm = new SageMakerClient({ region: REGION });
const log = (...a) => console.log(...a);

async function endpointConfigName(endpointName) {
  try {
    const { EndpointConfigName } = await sm.send(new (await import('@aws-sdk/client-sagemaker')).DescribeEndpointCommand({ EndpointName: endpointName }));
    return EndpointConfigName;
  } catch { return null; }
}

async function teardownOne(endpointName) {
  const cfg = await endpointConfigName(endpointName);
  let modelName = null;
  if (cfg) {
    try {
      const d = await sm.send(new DescribeEndpointConfigCommand({ EndpointConfigName: cfg }));
      modelName = d.ProductionVariants?.[0]?.ModelName ?? null;
    } catch { /* ignore */ }
  }
  try { await sm.send(new DeleteEndpointCommand({ EndpointName: endpointName })); log('刪 endpoint', endpointName); } catch (e) { log('刪 endpoint 失敗', e.message); }
  if (cfg) { try { await sm.send(new DeleteEndpointConfigCommand({ EndpointConfigName: cfg })); log('刪 config', cfg); } catch (e) { log('刪 config 失敗', e.message); } }
  if (modelName) { try { await sm.send(new DeleteModelCommand({ ModelName: modelName })); log('刪 model', modelName); } catch (e) { log('刪 model 失敗', e.message); } }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('用法: node teardownUitars.mjs <endpointName> | --all-ui-tars'); process.exitCode = 1; return; }
  if (arg === '--all-ui-tars') {
    const { Endpoints = [] } = await sm.send(new ListEndpointsCommand({ MaxResults: 100 }));
    const targets = Endpoints.filter((e) => (e.EndpointName || '').startsWith('ui-tars-'));
    if (targets.length === 0) { log('沒有 ui-tars- endpoint'); return; }
    for (const e of targets) await teardownOne(e.EndpointName);
  } else {
    await teardownOne(arg);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
