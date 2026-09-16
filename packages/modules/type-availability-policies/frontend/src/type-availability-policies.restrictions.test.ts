import type { AvailableTypesResponse } from '@n8n/api-types';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useNodeTypeRestrictions } from './type-availability-policies.restrictions';
import { useTypeAvailabilityPoliciesStore } from './type-availability-policies.store';

const mocks = vi.hoisted(() => ({
	fetchAvailableTypes: vi.fn(),
	isModuleActive: vi.fn(),
}));

vi.mock('./type-availability-policies.api', () => ({
	fetchAvailableTypes: mocks.fetchAvailableTypes,
}));

vi.mock('@n8n/stores/settings.store', () => ({
	useSettingsStore: () => ({ isModuleActive: mocks.isModuleActive }),
}));

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({
		restApiContext: { baseUrl: 'http://localhost', pushRef: 'test' },
	}),
}));

const ALLOWED = 'n8n-nodes-base.slack';
const RESTRICTED = 'n8n-nodes-base.executeCommand';
const UNKNOWN = 'n8n-nodes-base.doesNotExist';

const RESPONSE: AvailableTypesResponse = [
	{ name: ALLOWED, available: true },
	{ name: RESTRICTED, available: false, scope: 'instance', matchedRuleId: 'rule-1' },
];

describe('useNodeTypeRestrictions', () => {
	beforeEach(() => {
		mocks.fetchAvailableTypes.mockReset();
		mocks.isModuleActive.mockReset();
	});

	describe('when the module is off', () => {
		beforeEach(() => {
			mocks.isModuleActive.mockReturnValue(false);
		});

		it('reports every type as unrestricted', () => {
			const { isEnabled, getNodeTypeRestriction, isNodeTypeRestricted } = useNodeTypeRestrictions();

			expect(isEnabled.value).toBe(false);
			expect(getNodeTypeRestriction(RESTRICTED)).toBeUndefined();
			expect(isNodeTypeRestricted(RESTRICTED)).toBe(false);
		});
	});

	describe('when the module is on and a project is loaded', () => {
		beforeEach(async () => {
			mocks.isModuleActive.mockReturnValue(true);
			mocks.fetchAvailableTypes.mockResolvedValue(RESPONSE);
			await useTypeAvailabilityPoliciesStore().fetchForProject('project-a');
		});

		it('returns undefined for an available type', () => {
			const { getNodeTypeRestriction, isNodeTypeRestricted } = useNodeTypeRestrictions();

			expect(getNodeTypeRestriction(ALLOWED)).toBeUndefined();
			expect(isNodeTypeRestricted(ALLOWED)).toBe(false);
		});

		it('returns undefined for a type the endpoint did not list', () => {
			const { getNodeTypeRestriction } = useNodeTypeRestrictions();

			expect(getNodeTypeRestriction(UNKNOWN)).toBeUndefined();
		});

		it('returns the availability payload for a restricted type', () => {
			const { getNodeTypeRestriction, isNodeTypeRestricted } = useNodeTypeRestrictions();

			expect(getNodeTypeRestriction(RESTRICTED)).toEqual({
				name: RESTRICTED,
				available: false,
				scope: 'instance',
				matchedRuleId: 'rule-1',
			});
			expect(isNodeTypeRestricted(RESTRICTED)).toBe(true);
		});

		it('exposes the loaded project id for cache keys', () => {
			const { isEnabled, loadedProjectId } = useNodeTypeRestrictions();

			expect(isEnabled.value).toBe(true);
			expect(loadedProjectId.value).toBe('project-a');
		});
	});
});
