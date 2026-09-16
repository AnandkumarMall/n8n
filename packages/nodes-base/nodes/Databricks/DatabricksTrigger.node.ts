import {
	NodeConnectionTypes,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IPollFunctions,
} from 'n8n-workflow';

import { authenticationProperty, databricksCredentials } from './authentication';
import { DATABRICKS_TRIGGER_NODE_VERSION } from './constants';
import { getJobs } from './methods/listSearch';
import { pollJobRunEvents } from './trigger/jobRunEvents';

const showForJob = { resource: ['job'] };

export class DatabricksTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Databricks Trigger',
		name: 'databricksTrigger',
		hidden: true,
		icon: { light: 'file:databricks.svg', dark: 'file:databricks.dark.svg' },
		group: ['trigger'],
		version: DATABRICKS_TRIGGER_NODE_VERSION,
		description: 'Starts the workflow when Databricks job runs or pipeline updates change state',
		defaults: {
			name: 'Databricks Trigger',
		},
		credentials: databricksCredentials,
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			authenticationProperty,
			{
				displayName:
					'Use a credential that belongs to a service principal for triggers. A credential tied to a person stops firing when that person leaves or revokes consent.',
				name: 'servicePrincipalNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Job',
						value: 'job',
						description: 'Watch the runs of a job',
					},
				],
				default: 'job',
			},
			{
				displayName: 'Job',
				name: 'jobId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The job whose runs start the workflow',
				displayOptions: {
					show: showForJob,
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'getJobs',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. 281874479417551',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[0-9]+$',
									errorMessage: 'Must be a numeric job ID',
								},
							},
						],
					},
					{
						displayName: 'By URL',
						name: 'url',
						type: 'string',
						placeholder: 'e.g. https://adb-xxx.azuredatabricks.net/jobs/281874479417551',
						extractValue: {
							type: 'regex',
							regex: 'https://[^/]+/(?:jobs|\\?o=[0-9]+#job|#job)/([0-9]+)',
						},
					},
				],
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				displayOptions: {
					show: showForJob,
				},
				options: [
					{
						name: 'Run Failed',
						value: 'runFailed',
						description: 'A run ended without success, including cancelled and skipped runs',
					},
					{
						name: 'Run Started',
						value: 'runStarted',
						description: 'A new run of the job was seen',
					},
					{
						name: 'Run Succeeded',
						value: 'runSucceeded',
						description: 'A run ended with success',
					},
				],
				default: ['runFailed', 'runSucceeded'],
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description:
					'Whether to return a simplified version of the response instead of the raw data',
			},
		],
	};

	methods = {
		listSearch: { getJobs },
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		return await pollJobRunEvents.call(this);
	}
}
