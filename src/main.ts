import * as core from '@actions/core';
import * as github from '@actions/github';
import { Config, SchemaPointer } from '@graphql-inspector/github/dist/probot';
import {
  ActionResult,
  CheckConclusion,
  Annotation
} from '@graphql-inspector/github/dist/types';
import { diff } from '@graphql-inspector/github/dist/diff';
import { buildSchema } from 'graphql';
import { safeLoad } from 'js-yaml';
import { ChecksUpdateParams } from '@octokit/rest';

const base = '.github';
const identifier = 'graphql-inspector';

async function run() {
  core.info(`GraphQL Inspector started`);

  // env
  const ref = process.env.GITHUB_SHA!;

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
  const config = await loadConfig(tools, loadFile);

  if (!config) {
    core.error(`No config file`);
    return core.setFailed(`Failed to find any config file.`);
  }

  const oldPointer: SchemaPointer = config.schema;
  const newPointer: SchemaPointer = {
    path: oldPointer.path,
    ref
  };

  const schemas = {
    old: buildSchema(await loadFile(oldPointer)),
    new: buildSchema(await loadFile(newPointer))
  };

  tools.log.info(`Both schemas built`);

  const actions: Array<Promise<ActionResult>> = [];

  if (config.diff) {
    tools.log.info(`Start comparing schemas`);
    actions.push(
      diff({
        path: config.schema.path,
        schemas
      })
    );
  }

  const results = await Promise.all(actions);

  const conclusion = results.some(
    action => action.conclusion === CheckConclusion.Failure
  )
    ? CheckConclusion.Failure
    : CheckConclusion.Success;

  const annotations = results.reduce<Annotation[]>((annotations, action) => {
    if (action.annotations) {
      return annotations.concat(action.annotations);
    }

    return annotations;
  }, []);

  const issueInfo = `Found ${annotations.length} issue${
    annotations.length > 1 ? 's' : ''
  }`;

  const { title, summary } =
    conclusion === CheckConclusion.Failure
      ? {
          title: `Something is wrong with your schema`,
          summary: issueInfo
        }
      : {
          title: 'Everything looks good',
          summary: issueInfo
        };

  try {
    await updateCheckRun(tools, {
      conclusion,
      output: { title, summary, annotations }
    });
  } catch (e) {
    // Error
    core.error(e);
    return core.setFailed('Invalid config. Failed to add annotation');
  }
}

interface QueryResult {
  repository: null | {
    yaml: null | {
      text: null | string;
    };
    yml: null | {
      text: null | string;
    };
  };
}

function fileLoader({
  tools,
  owner,
  repo
}: {
  tools: github.GitHub;
  owner: string;
  repo: string;
}) {
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

  return async function loadFile(file: {
    ref: string;
    path: string;
  }): Promise<string> {
    const result: QueryResult = await tools.graphql(query, {
      repo,
      owner,
      yamlExpression: `${file.ref}:${file.path}.yaml`,
      ymlExpression: `${file.ref}:${file.path}.yml`
    });

    try {
      if (
        result &&
        result.repository &&
        result.repository.yaml &&
        result.repository.yaml.text
      ) {
        return result.repository.yaml.text;
      } else if (
        result &&
        result.repository &&
        result.repository.yml &&
        result.repository.yml.text
      ) {
        return result.repository.yml.text;
      }
      // @ts-ignore
      return result.repository.object.text;
    } catch (error) {
      console.log(result);
      console.error(error);
      throw new Error(
        `Failed to load '${file.path}.yaml' or '${file.path}.yml' (ref: ${file.ref})`
      );
    }
  };
}

async function loadConfig(
  tools: github.GitHub,
  loadFile: (file: { ref: string; path: string }) => Promise<string>
): Promise<Config | undefined> {
  const ref = process.env.GITHUB_SHA!;

  // TODO: Using `ref`

  try {
    const text = await loadFile({ ref, path: `${base}/${identifier}` });
    return safeLoad(text);
  } catch (e) {
    tools.log.info(e);
    tools.log.info(
      `Failed to find ${base}/${identifier}.yaml or ${base}/${identifier}.yml file`
    );
  }
}

type UpdateCheckRunOptions = Required<
  Pick<ChecksUpdateParams, 'conclusion' | 'output'>
>;
async function updateCheckRun(
  tools: github.GitHub,
  { conclusion, output }: UpdateCheckRunOptions
) {
  const checkName = process.env.GITHUB_ACTION!;

  const response = await tools.checks.listForRef({
    status: 'in_progress' as 'in_progress',
    ref: github.context.ref,
    ...github.context.repo
  });

  console.log(response);

  const check = response.data.check_runs.find(
    check => check.name === checkName
  );

  if (!check) {
    return core.setFailed(
      `Couldn't match the action '${checkName}' with a running check`
    );
  }

  await tools.checks.update({
    check_run_id: check.id,
    completed_at: new Date().toISOString(),
    status: 'completed',
    ...github.context.repo,
    conclusion,
    output
  });

  // Fail
  if (conclusion === CheckConclusion.Failure) {
    return core.setFailed(output.title || '');
  }

  // Success or Neutral
  return;
}

run();
