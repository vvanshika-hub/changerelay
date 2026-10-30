import test from 'node:test';
import assert from 'node:assert/strict';
import {startDurableWorker} from './worker.mjs';
test('the worker awaits a running cycle and does not overlap or retry on a second tick',async()=>{let release,calls=0;const work=new Promise(resolve=>{release=resolve;});const worker=startDurableWorker({cycle:async()=>{calls++;await work;},intervalMs:100000});await Promise.resolve();await worker.tick();assert.equal(calls,1);const stopping=worker.stop();release();await stopping;await worker.tick();assert.equal(calls,1);});
test('a worker transport failure is contained and later cycles can resume saved work',async()=>{let calls=0,errors=0;const worker=startDurableWorker({cycle:async()=>{calls++;throw Error('private-provider-details');},onError:message=>{assert.ok(!message.includes('private-provider'));errors++;},intervalMs:100000});await new Promise(resolve=>setImmediate(resolve));await worker.tick();await worker.stop();assert.equal(calls,2);assert.equal(errors,2);});
