import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  concurrency: number;
  waitMs: number;
  runTimeoutMs: number;
  repositoryPath: string;
  groups: Record<string, {owners:string[];webhook:string}>;
  bot: {id:string;secret:string};
  model: {provider:string;id:string;apiKey:string;endpoint?:string;api?:string};
  delivery: {apiEndpoint:string;token:string;project:string;requiredChecks:string[];agentReviewCheck:string};
  tools?: Record<string,{command:string;args?:string[]}>;
  skills?: string[];
  intake?: {source:string;eventIdPattern:string};
  phoenix?: {endpoint:string;apiKey?:string;publicUrl?:string};
}

export function loadConfig(file: string): Config {
  const raw=JSON.parse(readFileSync(file,'utf8'));
  // A value {env:"NAME"} resolves only at startup; examples never contain credentials.
  const expand=(value:any):any=>{
    if (value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===1 && typeof value.env==='string') {
      const result=process.env[value.env]; if(!result) throw new Error(`Missing environment variable ${value.env}`); return result;
    }
    if(Array.isArray(value))return value.map(expand);
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,expand(item)]));
    return value;
  };
  const c=expand(raw);
  for(const key of ['repositoryPath','dataDir'])if(typeof c[key]!=='string'||!c[key])throw new Error(`Missing ${key}`);
  if(!c.bot?.id||!c.bot?.secret||!c.model?.id||!c.model?.apiKey||!c.model?.provider)throw new Error('Bot and model configuration required');
  if(!c.delivery?.apiEndpoint||!c.delivery?.token||!c.delivery?.project||!c.delivery?.agentReviewCheck||!Array.isArray(c.delivery?.requiredChecks))throw new Error('Explicit delivery/check configuration required');
  if(!c.groups||typeof c.groups!=='object'||Array.isArray(c.groups)||!Object.keys(c.groups).length)throw new Error('Group configuration required');
  for(const group of Object.values(c.groups) as any[])if(!group||!Array.isArray(group.owners)||!group.owners.length||group.owners.some((x:any)=>typeof x!=='string'||!x.trim())||typeof group.webhook!=='string'||!group.webhook)throw new Error('Invalid group configuration');
  if(c.skills&&(!Array.isArray(c.skills)||c.skills.some((x:any)=>typeof x!=='string')))throw new Error('Invalid skills paths');
  if(c.intake){if(typeof c.intake.source!=='string'||typeof c.intake.eventIdPattern!=='string')throw new Error('Invalid intake config');new RegExp(c.intake.eventIdPattern);}
  c.dataDir=resolve(c.dataDir);c.repositoryPath=resolve(c.repositoryPath);
  c.host??='127.0.0.1';c.port??=8080;c.concurrency??=4;c.waitMs??=1_800_000;c.runTimeoutMs??=3_600_000;
  for(const key of ['port','concurrency','waitMs','runTimeoutMs'])if(!Number.isSafeInteger(c[key])||c[key]<1)throw new Error(`Invalid ${key}`);
  if(c.port>65535)throw new Error('Invalid port');
  return c as Config;
}
