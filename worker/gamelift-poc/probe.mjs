// 確認 GameLift Streams 在這個區域可用:列出 stream group / application。
import { GameLiftStreamsClient, ListStreamGroupsCommand, ListApplicationsCommand } from '@aws-sdk/client-gameliftstreams';
const region = process.argv[2] || 'us-east-2';
const c = new GameLiftStreamsClient({ region });
try {
  const g = await c.send(new ListStreamGroupsCommand({}));
  console.log('stream groups', JSON.stringify(g.Items ?? [], null, 1));
  const a = await c.send(new ListApplicationsCommand({}));
  console.log('applications', JSON.stringify(a.Items ?? [], null, 1));
} catch (e) {
  console.log('error', e.name, e.message);
}
