serId,userId,limit,offset).all<TopicRow>(),
    db.prepare("SELECT COUNT(*) AS count FROM topics")db.prepare("SELECT COUNT(*) AS count FROM topics WHERE user_id=? OR is_public=1").bind(userId),
    db.prepare("SELECT COUNT(*) AS count FROM topics WHERE user_id=?").bind(userId).first<{count:number}>()
  ]);
  return {topics:result.results.map(toTopic),totalCount:total?.count??0,ownedCount:owned?.count??0};
}
export async function getTopic(db:D1Database,viewerUserId:string,topicId:string):Promise<Topic|null> {
  const row=await db.prepare(`SELECT ${SELECT_COLUMNS} FROM topics t LEFT JOIN users u ON u.id=t.user_id
    WHERE t.id=? AND (t.user_id=? OR t.is_public=1) LIMIT 1`).bind(viewerUserId,topicId,viewerUserId).first<TopicRow>();
  return row?toTopic(row):null;
}
export async function createTopic(db:D1Database,userId:string,input:Required<TopicInput>):Promise<Topic> {
  const id=crypto.randomUUID();
  await db.prepare(`INSERT INTO topics (id,user_id,name,description,include_keywords_json,exclude_keywords_json,is_public)
    VALUES (?,?,?,?,?,?,?)`).bind(id,userId,input.name,input.description,
      JSON.stringify(input.includeKeywords),JSON.stringify(input.excludeKeywords),input.isPublic===true?1:0).run();
  const topic=await getTopic(db,userId,id);
  if(!topic)throw new Error("Created topic could not be loaded");
  return topic;
}
export async function updateTopic(db:D1Database,userId:string,topicId:string,input:Partial<TopicInput>):Promise<Topic|null> {
  const assignments:string[]=[]; const values:unknown[]=[];
  if(input.name!==undefined){assignments.push("name=?");values.push(input.name);}
  if(input.description!==undefined){assignments.push("description=?");values.push(input.description);}
  if(input.includeKeywords!==undefined){assignments.push("include_keywords_json=?");values.push(JSON.stringify(input.includeKeywords));}
  if(input.excludeKeywords!==undefined){assignments.push("exclude_keywords_json=?");values.push(JSON.stringify(input.excludeKeywords));}
  if(input.isPublic!==undefined){assignments.push("is_public=?");values.push(input.isPublic?1:0);}
  if(!assignments.length)return getTopic(db,userId,topicId);
  assignments.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  values.push(userId,topicId);
  const result=await db.prepare(`UPDATE topics SET ${assignments.join(",")} WHERE user_id=? AND id=?`).bind(...values).run();
  if((result.meta.changes??0)===0)return null;
  return getTopic(db,userId,topicId);
}
export async function deleteTopic(db:D1Database,userId:string,topicId:string):Promise<boolean> {
  const result=await db.prepare("DELETE FROM topics WHERE user_id=? AND id=?").bind(userId,topicId).run();
  return (result.meta.changes??0)>0;
}
