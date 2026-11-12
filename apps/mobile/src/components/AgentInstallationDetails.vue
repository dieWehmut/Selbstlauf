<script setup lang="ts">
import { installationLabel, type CatalogTool } from "../agent-installation";

defineProps<{ tool: CatalogTool }>();
</script>

<template>
  <div class="agent-installation" :data-tool="tool.id" :data-status="tool.installation?.status ?? 'unknown'">
    <p class="agent-installation-status">
      <span>电脑安装状态</span>
      <strong class="agent-installation-badge">{{ installationLabel(tool) }}</strong>
    </p>
    <dl v-if="tool.installation?.path || tool.installation?.extensions?.length" class="agent-installation-paths">
      <div v-if="tool.installation.path">
        <dt>电脑检测路径</dt><dd><code>{{ tool.installation.path }}</code></dd>
      </div>
      <div v-for="extension in tool.installation.extensions" :key="`${extension.id}:${extension.path}`">
        <dt>编辑器扩展 <code>{{ extension.id }}</code></dt><dd><code>{{ extension.path }}</code></dd>
      </div>
    </dl>
    <p v-if="tool.installation?.reason" class="hint">检测说明：{{ tool.installation.reason }}</p>
    <p v-else-if="!tool.installation" class="hint">电脑未返回安装检测结果。</p>
  </div>
</template>
