export const DEL_IF_EQUALS_SCRIPT = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

export const EXTEND_IF_EQUALS_SCRIPT = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end`;

export const DEL_SCRIPT = DEL_IF_EQUALS_SCRIPT;
export const EXTEND_SCRIPT = EXTEND_IF_EQUALS_SCRIPT;
