import { randomUUID } from 'node:crypto';

import { Document, type DocumentInterface } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';
import { isRecord } from '@n8n/utils/is-record';
import { OperationalError } from 'n8n-workflow';

type Fetch = typeof fetch;

export type DatabricksIndexInfo = {
	name: string;
	primaryKey: string;
	indexType: 'DELTA_SYNC' | 'DIRECT_ACCESS';
	/** Set when Databricks embeds server-side, so the index takes `query_text` only */
	embeddingSourceColumn?: string;
	embeddingModelEndpoint?: string;
	/** Set when the client embeds, so the index takes `query_vector` */
	vectorColumn?: string;
	/** DIRECT_ACCESS: keys of schema_json. DELTA_SYNC: columns_to_sync, or the Unity Catalog columns */
	schemaColumns?: string[];
	sourceTable?: string;
};

export interface DatabricksVectorStoreConfig {
	fetch: Fetch;
	/** https://..., no trailing slash */
	host: string;
	/** catalog.schema.index */
	indexName: string;
	/** Empty falls back to the embedding source column of a managed index */
	contentColumn?: string;
	/** Empty falls back to every schema column except the vector column */
	metadataColumns?: string[];
	queryType?: 'ANN' | 'HYBRID';
	/** Default filter when a search passes none (retrieve mode) */
	filter?: Record<string, unknown>;
}

const FULL_NAME = /^[^/\s]+\.[^/\s]+\.[^/\s]+$/;

// `.` and `..` survive encodeURIComponent, so the shape is checked before a URL is built
function assertFullName(value: string, what: string): void {
	if (!FULL_NAME.test(value)) {
		throw new OperationalError(`Invalid Databricks ${what} "${value}": use catalog.schema.${what}`);
	}
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined);
const records = (value: unknown): Array<Record<string, unknown>> =>
	Array.isArray(value) ? value.filter(isRecord) : [];
const stringArray = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
		? value
		: undefined;

export function parseIndexInfo(raw: unknown): DatabricksIndexInfo {
	const indexType = isRecord(raw) ? raw.index_type : undefined;
	if (
		!isRecord(raw) ||
		typeof raw.name !== 'string' ||
		typeof raw.primary_key !== 'string' ||
		(indexType !== 'DELTA_SYNC' && indexType !== 'DIRECT_ACCESS')
	) {
		throw new OperationalError('Unexpected Databricks index description');
	}

	const deltaSpec = isRecord(raw.delta_sync_index_spec) ? raw.delta_sync_index_spec : undefined;
	const directSpec = isRecord(raw.direct_access_index_spec)
		? raw.direct_access_index_spec
		: undefined;
	const spec = deltaSpec ?? directSpec ?? {};
	const [sourceColumn] = records(spec.embedding_source_columns);
	const [vectorColumn] = records(spec.embedding_vector_columns);

	let schemaColumns: string[] | undefined;
	if (typeof directSpec?.schema_json === 'string') {
		const schema: unknown = JSON.parse(directSpec.schema_json);
		schemaColumns = isRecord(schema) ? Object.keys(schema) : undefined;
	} else {
		// A Delta Sync index holds only the synced columns, so prefer them over the source table
		schemaColumns = stringArray(deltaSpec?.columns_to_sync);
	}

	return {
		name: raw.name,
		primaryKey: raw.primary_key,
		indexType,
		embeddingSourceColumn: optionalString(sourceColumn?.name),
		embeddingModelEndpoint: optionalString(sourceColumn?.embedding_model_endpoint_name),
		vectorColumn: optionalString(vectorColumn?.name),
		schemaColumns,
		sourceTable: optionalString(deltaSpec?.source_table),
	};
}

// Body text comes from whatever server `host` points at
function sanitizeMessage(message: string): string {
	// eslint-disable-next-line no-control-regex
	return message.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 500);
}

async function databricksRequest(
	fetchFn: Fetch,
	url: string,
	init?: RequestInit,
): Promise<unknown> {
	const response = await fetchFn(url, {
		...init,
		headers: { 'Content-Type': 'application/json' },
	});
	if (!response.ok) {
		// Only the response body reaches the message, so no bearer can leak
		const text = await response.text();
		let message = text;
		try {
			const parsed: unknown = JSON.parse(text);
			if (isRecord(parsed) && typeof parsed.message === 'string') message = parsed.message;
		} catch {}
		throw new OperationalError(
			`Databricks Vector Search request failed (${response.status}): ${sanitizeMessage(message)}`,
		);
	}
	return await response.json();
}

export class DatabricksVectorStore extends VectorStore {
	declare FilterType: Record<string, unknown>;

	private readonly fetch: Fetch;

	private readonly host: string;

	readonly index: DatabricksIndexInfo;

	private readonly contentColumn: string;

	private readonly metadataColumns: string[];

	private readonly queryType: 'ANN' | 'HYBRID';

	private readonly defaultFilter?: Record<string, unknown>;

	static async describeIndex(
		fetchFn: Fetch,
		host: string,
		indexName: string,
	): Promise<DatabricksIndexInfo> {
		assertFullName(indexName, 'index');
		const info = parseIndexInfo(
			await databricksRequest(
				fetchFn,
				`${host}/api/2.0/vector-search/indexes/${encodeURIComponent(indexName)}`,
			),
		);

		if (info.indexType === 'DELTA_SYNC' && !info.schemaColumns && info.sourceTable) {
			assertFullName(info.sourceTable, 'table');
			const response = await fetchFn(
				`${host}/api/2.1/unity-catalog/tables/${encodeURIComponent(info.sourceTable)}`,
			);
			// No UC privilege on the source table: the dropdown shows nothing and documents are content-only
			if (response.ok) {
				const table: unknown = await response.json();
				info.schemaColumns = records(isRecord(table) ? table.columns : undefined).flatMap(
					(column) => (typeof column.name === 'string' ? [column.name] : []),
				);
			}
		}
		return info;
	}

	static async fromExistingIndex(
		embeddings: EmbeddingsInterface,
		config: DatabricksVectorStoreConfig,
	): Promise<DatabricksVectorStore> {
		// ponytail: one describe GET (two on Delta Sync) per store creation; retrieve-as-tool
		// creates a store per tool call. Memoize per (host, index) if it shows up.
		const index = await DatabricksVectorStore.describeIndex(
			config.fetch,
			config.host,
			config.indexName,
		);
		return new DatabricksVectorStore(embeddings, { ...config, index });
	}

	constructor(
		embeddings: EmbeddingsInterface,
		config: DatabricksVectorStoreConfig & { index: DatabricksIndexInfo },
	) {
		super(embeddings, config);
		const { index } = config;
		const contentColumn = config.contentColumn || index.embeddingSourceColumn;
		if (!contentColumn) {
			throw new OperationalError(
				`Index ${index.name} uses self-managed embeddings. Select a content column`,
			);
		}
		this.fetch = config.fetch;
		this.host = config.host;
		this.index = index;
		this.contentColumn = contentColumn;
		this.metadataColumns = config.metadataColumns?.length
			? config.metadataColumns
			: (index.schemaColumns ?? []).filter((column) => column !== index.vectorColumn);
		this.queryType = config.queryType ?? 'ANN';
		this.defaultFilter = config.filter;
	}

	_vectorstoreType(): string {
		return 'databricks';
	}

	private get isManaged(): boolean {
		return this.index.embeddingSourceColumn !== undefined;
	}

	// The factory calls this on load and retrieve-as-tool (searchByText)
	async similaritySearchWithScore(
		query: string,
		k = 4,
		filter?: this['FilterType'],
	): Promise<Array<[Document, number]>> {
		if (this.isManaged) {
			return await this.query(
				{ num_results: k, query_type: this.queryType, query_text: query },
				filter,
			);
		}
		return await this.query(
			{
				num_results: k,
				query_type: this.queryType,
				query_vector: await this.embeddings.embedQuery(query),
				// HYBRID needs the text next to the vector
				...(this.queryType === 'HYBRID' && { query_text: query }),
			},
			filter,
		);
	}

	// The retriever calls this on retrieve; the base version would embed first
	async similaritySearch(query: string, k = 4, filter?: this['FilterType']): Promise<Document[]> {
		return (await this.similaritySearchWithScore(query, k, filter)).map(([doc]) => doc);
	}

	async similaritySearchVectorWithScore(
		query: number[],
		k: number,
		filter?: this['FilterType'],
	): Promise<Array<[Document, number]>> {
		if (this.isManaged) {
			throw new OperationalError(
				`Index ${this.index.name} uses Databricks-managed embeddings and accepts text queries only`,
			);
		}
		// HYBRID needs text this path does not have
		return await this.query({ num_results: k, query_type: 'ANN', query_vector: query }, filter);
	}

	async addDocuments(
		documents: DocumentInterface[],
		options?: { ids?: string[] },
	): Promise<string[]> {
		if (documents.length === 0) return [];
		this.assertDirectAccess();
		const vectors = await this.embeddings.embedDocuments(documents.map((doc) => doc.pageContent));
		return await this.addVectors(vectors, documents, options);
	}

	async addVectors(
		vectors: number[][],
		documents: DocumentInterface[],
		options?: { ids?: string[] },
	): Promise<string[]> {
		const vectorColumn = this.assertDirectAccess();
		const { primaryKey, name } = this.index;
		const reserved = new Set([primaryKey, this.contentColumn, vectorColumn]);
		const schemaColumns = new Set(this.index.schemaColumns ?? []);
		const ids = documents.map((doc, i) => options?.ids?.[i] ?? doc.id ?? randomUUID());

		// The loaders add keys like `source` and `loc` that would 400 against the schema
		const rows = documents.map((doc, i) => ({
			...Object.fromEntries(
				Object.entries(doc.metadata).filter(
					([key]) => schemaColumns.has(key) && !reserved.has(key),
				),
			),
			[primaryKey]: ids[i],
			[this.contentColumn]: doc.pageContent,
			[vectorColumn]: vectors[i],
		}));

		const response = await databricksRequest(
			this.fetch,
			`${this.host}/api/2.0/vector-search/indexes/${encodeURIComponent(name)}/upsert-data`,
			{ method: 'POST', body: JSON.stringify({ inputs_json: JSON.stringify(rows) }) },
		);
		if (!isRecord(response) || response.status !== 'SUCCESS') {
			const result = isRecord(response) && isRecord(response.result) ? response.result : {};
			const failed = stringArray(result.failed_primary_keys) ?? [];
			throw new OperationalError(
				`Databricks rejected the upsert into ${name}. Failed primary keys: ${failed.join(', ')}`,
			);
		}
		return ids;
	}

	// Databricks enforces `index_type` here; a Delta Sync index rejects upsert-data even when it holds its own vectors
	private assertDirectAccess(): string {
		const { indexType, vectorColumn, name } = this.index;
		if (indexType !== 'DIRECT_ACCESS' || !vectorColumn) {
			throw new OperationalError(
				`Index ${name} syncs from its source table. Use a Direct Access index to insert documents`,
			);
		}
		return vectorColumn;
	}

	private async query(
		body: Record<string, unknown>,
		filter?: Record<string, unknown>,
	): Promise<Array<[Document, number]>> {
		const { primaryKey, name } = this.index;
		const columns = [...new Set([primaryKey, this.contentColumn, ...this.metadataColumns])];
		const effectiveFilter = filter ?? this.defaultFilter;
		if (effectiveFilter && Object.keys(effectiveFilter).length > 0) {
			body.filters_json = JSON.stringify(effectiveFilter);
		}

		const response = await databricksRequest(
			this.fetch,
			`${this.host}/api/2.0/vector-search/indexes/${encodeURIComponent(name)}/query`,
			{ method: 'POST', body: JSON.stringify({ ...body, columns }) },
		);

		// Databricks returns the requested columns plus `score`; read every cell by manifest name
		const manifest = isRecord(response) && isRecord(response.manifest) ? response.manifest : {};
		const result = isRecord(response) && isRecord(response.result) ? response.result : {};
		const names = records(manifest.columns).map((column) => optionalString(column.name) ?? '');
		const rows = Array.isArray(result.data_array)
			? result.data_array.filter((row): row is unknown[] => Array.isArray(row))
			: [];
		const cell = (row: unknown[], column: string) => row[names.indexOf(column)];

		return rows.map((row) => [
			new Document({
				pageContent: String(cell(row, this.contentColumn) ?? ''),
				metadata: Object.fromEntries(
					this.metadataColumns.map((column) => [column, cell(row, column)]),
				),
				id: String(cell(row, primaryKey)),
			}),
			Number(cell(row, 'score')),
		]);
	}
}
