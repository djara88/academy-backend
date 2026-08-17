const scopedError = (message, status = 400, code = 'INVALID_SCOPE') => Object.assign(new Error(message), { status, code });

const assertSameBranch = (leftBranchId, rightBranchId, message = 'Los elementos seleccionados pertenecen a ramas deportivas distintas.') => {
  if (leftBranchId && rightBranchId && String(leftBranchId) !== String(rightBranchId)) {
    throw scopedError(message, 409, 'BRANCH_SCOPE_MISMATCH');
  }
};

module.exports = { scopedError, assertSameBranch };
