import fs from 'fs'
import path from 'path'
const { join } = path
const { lstatSync, readdirSync } = fs

const dirs = readdirSync(__dirname).filter((name) => lstatSync(join(__dirname, name)).isDirectory())
const migrations = dirs.sort().reverse()
export default migrations[0] ? migrations[0].split('_')[0] : migrations
