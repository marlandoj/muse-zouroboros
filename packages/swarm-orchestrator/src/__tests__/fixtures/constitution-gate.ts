const inputIndex = process.argv.indexOf('--input');
const input = inputIndex >= 0
  ? JSON.parse(process.argv[inputIndex + 1] ?? '{}') as Record<string, unknown>
  : {};

const decision = input.modifiesModelWeights === true
  ? {
    decision: 'BLOCK',
    violations: [{
      article: 'Article I',
      code: 'I-FROZEN-WEIGHTS',
      message: 'Model-weight modification is outside the governed swarm boundary.',
    }],
  }
  : { decision: 'ALLOW', violations: [] };

console.log(JSON.stringify(decision));
