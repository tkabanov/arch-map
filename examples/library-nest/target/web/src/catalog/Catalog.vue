<script setup lang="ts">
import { listBooks, openLoan, reserve } from './api';
const books = listBooks();
</script>
<template><button @click="openLoan">Borrow</button><button @click="reserve">Reserve</button><pre>{{ books }}</pre></template>
