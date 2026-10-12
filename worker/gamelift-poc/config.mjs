export const REGION = process.env.PA_SM_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';
export const ACCOUNT = (process.env.AWS_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT || '').trim();

if (!/^\d{12}$/.test(ACCOUNT)) {
  throw new Error('AWS_ACCOUNT_ID or CDK_DEFAULT_ACCOUNT is required and must be a 12-digit AWS account ID');
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(REGION)) {
  throw new Error(`Invalid AWS region: ${REGION}`);
}

/** PoC 專用桶(放 GameLift Streams 的 app 檔案、log、測試結果;不碰平台資料桶)。 */
export const BUCKET = `playagent-gls-poc-${ACCOUNT}-${REGION}`;
