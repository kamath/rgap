import { getDatabase } from './client.server'

await getDatabase()
console.log('RGAP migrations applied')
