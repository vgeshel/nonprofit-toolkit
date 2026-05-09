// TS-only, type-aware ESLint flat config
import type { ESLint, Rule } from 'eslint'
import prettier from 'eslint-config-prettier/flat'
import functional from 'eslint-plugin-functional'
import n from 'eslint-plugin-n'
import neverthrow from 'eslint-plugin-neverthrow'
import vitestPlugin from 'eslint-plugin-vitest'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

/**
 * TypeScript-specific AST node with type parameters.
 *
 * The base ESTree CallExpression does not include typeArguments or
 * typeParameters — these are extensions added by @typescript-eslint/parser.
 * This interface lets us safely access them via type guards.
 */
interface TSCallExpression {
  callee: {
    type: string
    object?: { type: string; name?: string }
    property?: { type: string; name?: string }
  }
  arguments: unknown[]
  typeArguments?: { params: TSTypeNode[] }
  typeParameters?: { params: TSTypeNode[] }
}

interface TSTypeNode {
  type: string
  returnType?: { typeAnnotation?: { type: string } }
}

/**
 * Custom ESLint rule: require-typed-vi-fn
 *
 * Ensures every vi.fn() call has an explicit type parameter with the real
 * function signature. Catches two anti-patterns:
 *
 * 1. Bare vi.fn() — returns any, defeats all type checking
 * 2. vi.fn<(...args: unknown[]) => unknown>() — silences lint but provides
 *    no type safety (unknown return type means TypeScript cannot catch wrong
 *    mock return values)
 *
 * Skips vi.fn(impl) calls where an implementation argument is provided,
 * since TypeScript infers the type from the implementation.
 */
const requireTypedViFn: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require vi.fn() calls to have explicit type parameters matching the real function signature',
    },
    messages: {
      untypedViFn:
        'vi.fn() must have a type parameter with the real function signature. Read the source module and use: vi.fn<(params) => ReturnType>()',
      unknownReturnType:
        'vi.fn() type parameter must use the real return type, not `unknown`. Read the source module for the correct signature.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(baseNode) {
        const node = baseNode as unknown as TSCallExpression

        // Only match vi.fn(...)
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.object?.type !== 'Identifier' ||
          node.callee.object.name !== 'vi' ||
          node.callee.property?.type !== 'Identifier' ||
          node.callee.property.name !== 'fn'
        ) {
          return
        }

        // If vi.fn(impl) has an implementation argument, TypeScript infers types — skip
        if (node.arguments.length > 0) {
          return
        }

        // Check for type arguments (typeArguments in @typescript-eslint AST)
        const typeArgs = node.typeArguments ?? node.typeParameters
        if (!typeArgs || typeArgs.params.length === 0) {
          context.report({ node: baseNode, messageId: 'untypedViFn' })
          return
        }

        // Check if the type argument is a function type with unknown return
        const typeArg = typeArgs.params[0]
        if (typeArg?.type === 'TSFunctionType') {
          const returnType = typeArg.returnType?.typeAnnotation
          if (returnType && returnType.type === 'TSUnknownKeyword') {
            context.report({ node: baseNode, messageId: 'unknownReturnType' })
          }
        }
      },
    }
  },
}

const localPlugin: ESLint.Plugin = {
  rules: {
    'require-typed-vi-fn': requireTypedViFn,
  },
}

export default defineConfig(
  // Always ignore build artifacts and the config file itself
  globalIgnores([
    'dist/**',
    'node_modules/**',
    'coverage/**',
    '.turbo/**',
    'eslint.config.*',
    'vitest.config.ts',
    '.next/**',
    '**/dist/**',
    '.claude/**',
    '*-workspace/**',
    '.claude/skills/**',
    '.codex/skills/**',
  ]),

  // One TS-only ruleset for the whole repo
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      functional,
      n,
      neverthrow,
    },
    rules: {
      // Practical TS strictness for CLIs
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/require-await': 'off',

      // TS already handles unused vars; fine-tune:
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_' },
      ],

      // Ban all as type assertions - use Zod validation or type guards instead
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Result pattern enforcement: ban throw statements to make error paths
      // visible to coverage tools (see plan for rationale)
      'functional/no-throw-statements': 'error',

      // Ban direct process.env access
      'n/no-process-env': 'error',

      // Ensure Result values are always handled (not silently ignored)
      // TODO: Enable once we migrate to Result types (requires type-aware config)
      // 'neverthrow/must-use-result': 'error',
    },
  },

  // Allow throw statements in entry points, scripts, and test files
  {
    files: [
      'actions/*/index.ts',
      'apps/*/src/main.ts',
      'apps/mcp/src/auth/provider.ts',
      'scripts/**/*.ts',
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/test-utils.ts',
    ],
    rules: {
      'functional/no-throw-statements': 'off',
    },
  },

  // Test file relaxations
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    plugins: {
      local: localPlugin,
    },
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // Enforce typed mocks
      'local/require-typed-vi-fn': 'error',
    },
  },

  // Allow direct process.env access in environment configuration modules, entrypoints, and their tests
  {
    files: [
      'actions/shared/env.ts',
      'actions/shared/tests/env.test.ts',
      'apps/runner/src/config.ts',
      'apps/runner/src/logger.ts',
      'apps/runner/tests/config.test.ts',
      'apps/runner/tests/logger.test.ts',
      'apps/service/src/config.ts',
      'apps/service/src/logger.ts',
      'apps/service/tests/config.test.ts',
      'apps/service/tests/logger.test.ts',
      'apps/mcp/src/config.ts',
      'apps/mcp/src/logger.ts',
      'apps/mcp/tests/config.test.ts',
      'apps/mcp/tests/logger.test.ts',
      'packages/letter/src/html.ts',
      'packages/letter/src/pdf.ts',
      'src/compliance/sources/browser-page.ts',
      'scripts/**/*.ts',
      'playwright/playwright.config.ts',
    ],
    rules: {
      'n/no-process-env': 'off',
    },
  },

  // Allow unbound methods in test files (common with mock assertions like
  // expect(mock.method).toHaveBeenCalled())
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  prettier,

  // Vitest tests (TS only)
  {
    files: ['test/**/*.{test,spec}.ts'],
    plugins: { vitest: vitestPlugin },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
    },
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
)
