.DEFAULT_GOAL := run

# Local development defaults; override with e.g. make run PORT=3001.
HOST ?= 127.0.0.1
PORT ?= 3000
CORS_ORIGIN ?= http://localhost:$(PORT)
BOT_API_SECRET ?= local-test-secret
DB_PATH ?= ./data/local-test.db

export HOST PORT CORS_ORIGIN BOT_API_SECRET DB_PATH

.PHONY: run install test

run:
	npm start -- --create-test-room

install:
	npm ci

test:
	npm test
