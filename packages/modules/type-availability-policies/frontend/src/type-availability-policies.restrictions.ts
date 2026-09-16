import type { NodeTypeAvailability } from '@n8n/api-types';
import { computed } from 'vue';

import { useTypeAvailabilityPoliciesStore } from './type-availability-policies.store';

/**
 * The read API for every surface that shows a restricted node type. The store answers
 * `{ available: true }` for a type it has never heard of; this turns that into `undefined`
 * so call sites read as a plain truth test and never unpack a payload they do not need.
 */
export function useNodeTypeRestrictions() {
	const policies = useTypeAvailabilityPoliciesStore();

	const isEnabled = computed(() => policies.isEnabled);
	const loadedProjectId = computed(() => policies.loadedProjectId);

	function getNodeTypeRestriction(name: string): NodeTypeAvailability | undefined {
		if (!policies.isEnabled) return undefined;
		const availability = policies.getNodeTypeAvailability(name);
		return availability.available ? undefined : availability;
	}

	function isNodeTypeRestricted(name: string): boolean {
		return getNodeTypeRestriction(name) !== undefined;
	}

	return { isEnabled, loadedProjectId, getNodeTypeRestriction, isNodeTypeRestricted };
}
