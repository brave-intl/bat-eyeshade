import path from 'path'
import _ from 'underscore'
const {
  last,
  pick
} = _
const {
  join,
  sep
} = path
const {
  SERVICE
} = process.env
const cwd = process.cwd()
const parentPath = join(cwd, '..')
const parentSplit = parentPath.split(sep)
const parentSplitLast = last(parentSplit)
const notNodeMods = parentSplitLast !== 'node_modules'
const PACKAGE = 'package'
const rootNpmInfoPath = notNodeMods ? cwd : join(parentPath, '..')
const npmInfoPath = join(rootNpmInfoPath, PACKAGE)
const npminfo = require(npmInfoPath)
if (SERVICE) {
  npminfo.name = 'bat-' + SERVICE
}
const attrs = [
  'name',
  'version',
  'description',
  'author',
  'license',
  'bugs',
  'homepage',
  'dependencies'
]
export default pick(npminfo, attrs)
