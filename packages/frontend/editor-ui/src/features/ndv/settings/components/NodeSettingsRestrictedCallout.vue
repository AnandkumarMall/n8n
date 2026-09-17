<script setup lang="ts">
import { computed, ref } from 'vue';
import { N8nButton, N8nCallout, N8nText } from '@n8n/design-system';
import { useI18n, type BaseTextKey } from '@n8n/i18n';

import ContactInstanceAdminModal from '@/app/components/ContactInstanceAdminModal.vue';

const props = withDefaults(
	defineProps<{
		nodeTypeName: string;
		scope?: string;
		showReplace?: boolean;
	}>(),
	{ scope: undefined, showReplace: true },
);

const emit = defineEmits<{ replaceNode: [] }>();

const i18n = useI18n();
const isContactAdminOpen = ref(false);

const descriptionKey = computed<BaseTextKey>(() => {
	if (props.scope === 'instance') return 'nodeSettings.restricted.description.instance';
	if (props.scope === 'project') return 'nodeSettings.restricted.description.project';
	return 'nodeSettings.restricted.description.generic';
});

const interpolate = computed(() => ({ nodeType: props.nodeTypeName }));
</script>

<template>
	<div>
		<N8nCallout
			theme="warning"
			icon="lock"
			:class="$style.callout"
			data-test-id="node-restricted-callout"
		>
			<N8nText :class="$style.line" size="small" bold>
				{{ i18n.baseText('nodeSettings.restricted.title') }}
			</N8nText>
			<N8nText :class="$style.line" size="small">
				{{ i18n.baseText(descriptionKey, { interpolate }) }}
			</N8nText>
			<template #trailingContent>
				<div :class="$style.actions">
					<N8nButton
						variant="solid"
						size="small"
						data-test-id="node-restricted-contact-admin"
						@click="isContactAdminOpen = true"
					>
						{{ i18n.baseText('nodeSettings.restricted.contactAdmin') }}
					</N8nButton>
					<N8nButton
						v-if="showReplace"
						variant="subtle"
						size="small"
						icon="refresh-cw"
						data-test-id="node-restricted-replace"
						@click="emit('replaceNode')"
					>
						{{ i18n.baseText('nodeSettings.restricted.replaceNode') }}
					</N8nButton>
				</div>
			</template>
		</N8nCallout>
		<ContactInstanceAdminModal
			v-model:open="isContactAdminOpen"
			:description="
				i18n.baseText('nodeSettings.restricted.contactAdmin.description', { interpolate })
			"
			:mail-subject="
				i18n.baseText('nodeSettings.restricted.contactAdmin.mailSubject', { interpolate })
			"
		/>
	</div>
</template>

<style lang="scss" module>
.callout {
	flex-direction: column;
	align-items: stretch;
	gap: var(--spacing--2xs);
	margin-top: var(--spacing--xs);
}

.line {
	display: block;
}

.actions {
	display: flex;
	gap: var(--spacing--2xs);
	padding-left: calc(var(--spacing--md) + var(--spacing--2xs));
}
</style>
