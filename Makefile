.PHONY: setup lint lint-fix check test

## Install dependencies
setup:
	npm ci

## Run ESLint across the package
lint:
	npx eslint .

## Auto-fix what ESLint can
lint-fix:
	npx eslint . --fix

## Type-check without emitting
check:
	npx tsc --noEmit

## Run the test suite (lint and check run first, matching both consumers)
test: lint check
	npm run test
