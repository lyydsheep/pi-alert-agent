import { backupData, restoreData } from '../src/backup.ts';

const [operation,source,destination]=process.argv.slice(2);
if(!source||!destination||!['backup','restore'].includes(operation))throw new Error('Usage: node scripts/backup.ts backup|restore SOURCE DESTINATION');
if(operation==='backup')await backupData(source,destination);else await restoreData(source,destination);
