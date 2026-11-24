import { spawnSync } from 'node:child_process'

// What to try, in order: the plain names, python3.N from newest to oldest, then the Windows launcher.
const PYTHONS = [
	['python3'],
	['python'],
	...Array.from({ length: 10 }, (_, index) => [`python3.${20 - index}`]),
	['py', '-3'],
]

// The full path of a Python 3.11+ on this machine's PATH, or undefined when there is none.
function findRealPython() {
	for (const [command, ...args] of PYTHONS) {
		const result = spawnSync(command, [...args, '-c', 'import sys,tomllib;print(sys.executable)'], { encoding: 'utf8' })
		if (result.status === 0) return result.stdout.trim()
	}
	return undefined
}

export const REAL_PYTHON = findRealPython()
// The reason for node:test to skip tests that need a Python 3.11+, or false when one exists.
export const NO_PYTHON_REASON = REAL_PYTHON ? false : 'no Python 3.11+ on this machine'
