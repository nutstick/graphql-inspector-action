"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const types_1 = require("@graphql-inspector/github/dist/types");
const diff_1 = require("@graphql-inspector/github/dist/diff");
const graphql_1 = require("graphql");
const js_yaml_1 = require("js-yaml");
const base = '.github';
const identifier = 'graphql-inspector';
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        core.info(`GraphQL Inspector started`);
        // env
        const ref = process.env.GITHUB_SHA;
        // repo
        const { owner, repo } = github.context.repo;
        if (!process.env.GITHUB_TOKEN) {
            return core.setFailed(`process.env.GITHUB_TOKEN is not provided.`);
        }
        const tools = new github.GitHub(process.env.GITHUB_TOKEN);
        const loadFile = fileLoader({
            tools,
            owner,
            repo
        });
        // config
        const config = yield loadConfig(tools, loadFile);
        if (!config) {
            core.error(`No config file`);
            return core.setFailed(`Failed to find any config file.`);
        }
        const oldPointer = config.schema;
        const newPointer = {
            path: oldPointer.path,
            ref
        };
        const schemas = {
            old: graphql_1.buildSchema(yield loadFile(oldPointer)),
            new: graphql_1.buildSchema(yield loadFile(newPointer))
        };
        tools.log.info(`Both schemas built`);
        const actions = [];
        if (config.diff) {
            tools.log.info(`Start comparing schemas`);
            actions.push(diff_1.diff({
                path: config.schema.path,
                schemas
            }));
        }
        const results = yield Promise.all(actions);
        const conclusion = results.some(action => action.conclusion === types_1.CheckConclusion.Failure)
            ? types_1.CheckConclusion.Failure
            : types_1.CheckConclusion.Success;
        const annotations = results.reduce((annotations, action) => {
            if (action.annotations) {
                return annotations.concat(action.annotations);
            }
            return annotations;
        }, []);
        const issueInfo = `Found ${annotations.length} issue${annotations.length > 1 ? 's' : ''}`;
        const { title, summary } = conclusion === types_1.CheckConclusion.Failure
            ? {
                title: `Something is wrong with your schema`,
                summary: issueInfo
            }
            : {
                title: 'Everything looks good',
                summary: issueInfo
            };
        try {
            yield updateCheckRun(tools, {
                conclusion,
                output: { title, summary, annotations }
            });
        }
        catch (e) {
            // Error
            core.error(e);
            return core.setFailed('Invalid config. Failed to add annotation');
        }
    });
}
function fileLoader({ tools, owner, repo }) {
    const query = `
    query GetFile($repo: String!, $owner: String!, $yamlExpression: String!, $ymlExpression: String!) {
      repository(name: $repo, owner: $owner) {
        yaml: object(expression: $yamlExpression) {
          ... on Blob {
            text
          }
        }
        yml: object(expression: $ymlExpression) {
          ... on Blob {
            text
          }
        }
      }
    }
  `;
    return function loadFile(file) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield tools.graphql(query, {
                repo,
                owner,
                yamlExpression: `${file.ref}:${file.path}.yaml`,
                ymlExpression: `${file.ref}:${file.path}.yml`
            });
            try {
                if (result.data &&
                    result.data.repository &&
                    result.data.repository.yaml &&
                    result.data.repository.yaml.text) {
                    return result.data.repository.yaml.text;
                }
                else if (result.data &&
                    result.data.repository &&
                    result.data.repository.yml &&
                    result.data.repository.yml.text) {
                    return result.data.repository.yml.text;
                }
                // @ts-ignore
                return result.repository.object.text;
            }
            catch (error) {
                console.log(result);
                console.error(error);
                throw new Error(`Failed to load '${file.path}.yaml' or '${file.path}.yml' (ref: ${file.ref})`);
            }
        });
    };
}
function loadConfig(tools, loadFile) {
    return __awaiter(this, void 0, void 0, function* () {
        const ref = process.env.GITHUB_SHA;
        // TODO: Using `ref`
        try {
            const text = yield loadFile({ ref, path: `${base}/${identifier}` });
            return js_yaml_1.safeLoad(text);
        }
        catch (e) {
            tools.log.info(e);
            tools.log.info(`Failed to find ${base}/${identifier}.yaml or ${base}/${identifier}.yml file`);
        }
    });
}
function updateCheckRun(tools, { conclusion, output }) {
    return __awaiter(this, void 0, void 0, function* () {
        const checkName = process.env.GITHUB_ACTION;
        const response = yield tools.checks.listForRef(Object.assign({ status: 'in_progress', ref: github.context.ref }, github.context.repo));
        console.log(response);
        const check = response.data.check_runs.find(check => check.name === checkName);
        if (!check) {
            return core.setFailed(`Couldn't match the action '${checkName}' with a running check`);
        }
        yield tools.checks.update(Object.assign(Object.assign({ check_run_id: check.id, completed_at: new Date().toISOString(), status: 'completed' }, github.context.repo), { conclusion,
            output }));
        // Fail
        if (conclusion === types_1.CheckConclusion.Failure) {
            return core.setFailed(output.title || '');
        }
        // Success or Neutral
        return;
    });
}
run();
