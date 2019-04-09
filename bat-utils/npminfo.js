const {
  join,
  sep
} = require('path')
const {
  last,
  pick
} = require('underscore')
const {
  SERVICE
} = require('../env')
const cwd = process.cwd()
const parent = join(cwd, '..')
const parentSplit = parent.split(sep)
const parentSplitLast = last(parentSplit)
const notNodeMods = parentSplitLast !== 'node_modules'
const PACKAGE = 'package'
const rootNpmInfoPath = notNodeMods ? cwd : join(parent, '..')
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
module.exports = pick(npminfo, attrs)
