import { createServer } from 'node:http';
import { createPhoenixGateway } from './phoenix-gateway.ts';

const upstream=process.env.PHOENIX_INTERNAL_URL;
const viewerKey=process.env.PHOENIX_VIEWER_KEY;
if(!upstream||!viewerKey)throw new Error('PHOENIX_INTERNAL_URL and PHOENIX_VIEWER_KEY are required');
const server=createServer(createPhoenixGateway({upstream,viewerKey}));
server.listen(Number(process.env.PORT??8081),process.env.HOST??'127.0.0.1');
process.on('SIGTERM',()=>server.close());
