'use strict';

function systemError(code, errno, syscall) {
  return Object.assign(new Error(code + ': ' + syscall), { code, errno, syscall });
}

module.exports = { systemError };
